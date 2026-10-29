"""Experimental minimal Apache Parquet v1 format writer/reader, NOT a general Parquet library.

Pure Python codec for isolated protocol testing where DuckDB/PyArrow binaries are absent.
Writes required UTF8/BYTE_ARRAY columns, one uncompressed PLAIN data page per column,
one row group, TCompactProtocol Thrift metadata, PAR1 header/footer. Values carry
canonical row JSON. Does NOT implement compression, native numeric columns, nulls,
nested column types, large dataset streaming, or production hardening.

Use DuckDB/PyArrow for production storage and independent compatibility validation.
Apache Parquet specification: https://parquet.apache.org/docs/file-format/
"""
from __future__ import annotations
from thrift.Thrift import TType
from thrift.protocol.TCompactProtocol import TCompactProtocol
from thrift.transport.TTransport import TMemoryBuffer
import struct, json
from typing import Any

MAGIC=b'PAR1'
COLS=('product_id','output_key','subject_id','business_key','payload_kind','observation_utc','row_json')
MAX_STR=4_000_000

def F(id_, typ, val): return (id_,typ,val)
def LIST(typ,vals): return (typ,vals)

def _write_value(p, typ, value):
    if typ==TType.STRUCT:
        _write_struct(p,value)
    elif typ==TType.LIST:
        elem,items=value
        p.writeListBegin(elem,len(items))
        for v in items:_write_value(p,elem,v)
        p.writeListEnd()
    elif typ==TType.STRING:
        if isinstance(value,str):value=value.encode('utf8')
        p.writeBinary(value)
    elif typ==TType.I32:p.writeI32(value)
    elif typ==TType.I64:p.writeI64(value)
    elif typ==TType.BOOL:p.writeBool(value)
    else:raise ValueError('unsupported thrift type')

def _write_struct(p,fields):
    p.writeStructBegin('P')
    for fid,typ,value in fields:
        p.writeFieldBegin('f',typ,fid)
        _write_value(p,typ,value)
        p.writeFieldEnd()
    p.writeFieldStop();p.writeStructEnd()

def encode_struct(fields)->bytes:
    m=TMemoryBuffer();p=TCompactProtocol(m);_write_struct(p,fields)
    return m.getvalue()

def _read_value(p,typ):
    if typ==TType.STRUCT:return _read_struct(p)
    if typ==TType.LIST:
        elem,count=p.readListBegin()
        if count>100000:raise ValueError('list too large')
        vs=[_read_value(p,elem) for _ in range(count)];p.readListEnd();return vs
    if typ==TType.STRING:return p.readBinary()
    if typ==TType.I32:return p.readI32()
    if typ==TType.I64:return p.readI64()
    if typ==TType.BOOL:return p.readBool()
    raise ValueError(f'unsupported thrift field type {typ}')

def _read_struct(p):
    p.readStructBegin();o={}
    while True:
        _,typ,fid=p.readFieldBegin()
        if typ==TType.STOP:break
        if fid in o:raise ValueError('duplicate thrift field')
        o[fid]=_read_value(p,typ);p.readFieldEnd()
    p.readStructEnd();return o

def read_struct(b:bytes):
    m=TMemoryBuffer(b); p=TCompactProtocol(m);return _read_struct(p)

def _str(v):return v.decode('utf8') if isinstance(v,bytes) else str(v)

def _page_header(num_values:int, body_size:int)->bytes:
    data_hdr=[F(1,TType.I32,num_values),F(2,TType.I32,0),F(3,TType.I32,3),F(4,TType.I32,3)]
    return encode_struct([F(1,TType.I32,0),F(2,TType.I32,body_size),F(3,TType.I32,body_size),F(5,TType.STRUCT,data_hdr)])

def _schema_element(name:str, root_children:int|None=None):
    if root_children is not None:return [F(4,TType.STRING,name),F(5,TType.I32,root_children)]
    return [F(1,TType.I32,6),F(3,TType.I32,0),F(4,TType.STRING,name),F(6,TType.I32,0)]

def encode_parquet(rows:list[dict])->bytes:
    """Encode row dicts. All seven physical columns are required UTF8 strings."""
    if not rows:raise ValueError('EMPTY_PARQUET_ROWS')
    for row in rows:
        if set(row)!=set(COLS):raise ValueError('COLUMN_MISMATCH')
        if any(not isinstance(row[col],str) for col in COLS):raise ValueError('STRING_ONLY')
    buf=bytearray(MAGIC);column_chunks=[];total_len=0
    for col in COLS:
        body=bytearray()
        for row in rows:
            bb=row[col].encode('utf8')
            if len(bb)>MAX_STR:raise ValueError('STRING_TOO_LARGE')
            body.extend(struct.pack('<I',len(bb)));body.extend(bb)
        header=_page_header(len(rows),len(body));offset=len(buf)
        buf.extend(header);buf.extend(body)
        col_len=len(header)+len(body);total_len+=col_len
        metadata=[
            F(1,TType.I32,6),                   # BYTE_ARRAY
            F(2,TType.LIST,LIST(TType.I32,[0])),# PLAIN
            F(3,TType.LIST,LIST(TType.STRING,[col])),
            F(4,TType.I32,0),                   # UNCOMPRESSED
            F(5,TType.I64,len(rows)),
            F(6,TType.I64,col_len),F(7,TType.I64,col_len),
            F(9,TType.I64,offset)
        ]
        column_chunks.append([
            F(2,TType.I64,offset),F(3,TType.STRUCT,metadata)
        ])
    rowgroup=[F(1,TType.LIST,LIST(TType.STRUCT,column_chunks)),F(2,TType.I64,total_len),F(3,TType.I64,len(rows)),F(6,TType.I64,total_len)]
    schema=[_schema_element('schema',len(COLS))]+[_schema_element(c) for c in COLS]
    footer=encode_struct([
        F(1,TType.I32,1),
        F(2,TType.LIST,LIST(TType.STRUCT,schema)),
        F(3,TType.I64,len(rows)),
        F(4,TType.LIST,LIST(TType.STRUCT,[rowgroup])),
        F(6,TType.STRING,'WFD parquet-lite test codec 0.1')
    ])
    buf.extend(footer);buf.extend(struct.pack('<I',len(footer)));buf.extend(MAGIC)
    return bytes(buf)

def parse_footer(b:bytes):
    if len(b)<12 or b[:4]!=MAGIC or b[-4:]!=MAGIC:raise ValueError('PARQUET_MAGIC_INVALID')
    footer_len=struct.unpack('<I',b[-8:-4])[0]
    if footer_len<=0 or footer_len>len(b)-12:raise ValueError('PARQUET_FOOTER_INVALID')
    footer=read_struct(b[-8-footer_len:-8])
    if footer.get(1)!=1:raise ValueError('PARQUET_VERSION_UNSUPPORTED')
    return footer

def decode_parquet(b:bytes)->list[dict[str,str]]:
    footer=parse_footer(b)
    schema=footer[2]
    if [_str(v[4]) for v in schema[1:]]!=list(COLS):raise ValueError('PARQUET_SCHEMA_MISMATCH')
    count=footer[3]
    if count<=0 or count>200000:raise ValueError('PARQUET_ROW_LIMIT')
    rowgroups=footer[4]
    if len(rowgroups)!=1:raise ValueError('PARQUET_ROWGROUP_UNSUPPORTED')
    chunks=rowgroups[0][1]
    if len(chunks)!=len(COLS):raise ValueError('PARQUET_CHUNKS_MISMATCH')
    data={}
    for i,col in enumerate(COLS):
        cm=chunks[i][3]
        if cm[1]!=6 or cm[4]!=0 or cm[5]!=count:raise ValueError('PARQUET_COLUMN_TYPE_UNSUPPORTED')
        if [_str(x) for x in cm[3]]!=[col]:raise ValueError('PARQUET_COLUMN_PATH_MISMATCH')
        off=cm[9];p=TCompactProtocol(TMemoryBuffer(b[off:]))
        hdr=_read_struct(p)
        # Header length is the compact thrift stream read position.
        hlen=p.trans.tell() if hasattr(p.trans,'tell') else p.trans._buffer.tell()
        if hdr[1]!=0 or hdr[2]!=hdr[3] or hdr[5][1]!=count or hdr[5][2]!=0:
            raise ValueError('PARQUET_PAGE_UNSUPPORTED')
        page=b[off+hlen:off+hlen+hdr[3]]
        if len(page)!=hdr[3]:raise ValueError('PARQUET_DATA_TRUNCATED')
        pos=0;items=[]
        for _ in range(count):
            if pos+4>len(page):raise ValueError('PARQUET_DATA_TRUNCATED')
            n=struct.unpack('<I',page[pos:pos+4])[0];pos+=4
            if n>MAX_STR or pos+n>len(page):raise ValueError('PARQUET_STRING_INVALID')
            items.append(page[pos:pos+n].decode('utf8'));pos+=n
        if pos!=len(page):raise ValueError('PARQUET_PAGE_EXTRA_BYTES')
        data[col]=items
    return [{k:data[k][i] for k in COLS} for i in range(count)]

def rows_from_parquet(b:bytes)->list[dict]:
    parsed=decode_parquet(b)
    result=[]
    for row in parsed:
        item=json.loads(row['row_json'])
        expected=item.get('business_key',item.get('event_id',''))
        if row['business_key']!=expected:raise ValueError('PARQUET_KEY_MISMATCH')
        result.append(item)
    return result

def parquet_from_rows(product_id:str,output_key:str,subject:dict,payload_kind:str,rows:list[dict])->bytes:
    physical=[]
    for row in rows:
        t=row.get('observation_time') or row.get('public_time') or row.get('event_time') or row.get('effective_period')
        physical.append(dict(product_id=product_id, output_key=output_key,subject_id=subject['id'],
            business_key=row.get('business_key',row.get('event_id','')),payload_kind=payload_kind,
            observation_utc=((t or {}).get('earliest_utc') or ''),row_json=json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(',',':'))))
    return encode_parquet(physical)
