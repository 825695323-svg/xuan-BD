"""Small tabular reads retain query semantics under cumulative catalog growth."""
import copy
import pytest
from test_fixed_read_pages import make_data_service
from test_r1_data_only import scalar_output, request as submit_request
from test_product_query import request, known_day
from wfd_sdk.product_query import ProductQuery, ProductQueryError


def tabular_output():
    output=scalar_output('table','tabular.budget.target','1')
    output['definition']['unit_code']='per_field'
    output['definition']['field_definitions']=[
        {'field_code':'amount','data_type':'decimal','unit_code':'count','measurement_nature':'stock','time_role':'observation'},
        {'field_code':'label','data_type':'text','unit_code':'text','measurement_nature':'stock','time_role':'observation'}]
    output['payload']={'kind':'tabular_rows','rows':[
        {'business_key':key,'subject':copy.deepcopy(output['subject']),'observation_time':known_day(2025,1,day),
         'values':{'amount':{'data_type':'decimal','value_state':'valid_value','value':'9007199254740993.12345678'},
                   'label':{'data_type':'text','value_state':'valid_value','value':key}}}
        for key,day in [('a',4),('z',1),('m',3),('n',2)]]}
    return output


def test_tabular_preserves_complete_projection_time_order_and_original_cursor(tmp_path,monkeypatch):
    service=make_data_service(tmp_path)
    result=service.submit(submit_request([tabular_output()],'target'))
    assert result['state']=='published_formal',result
    sid,pid=result['snapshot_id'],result['output_results'][0]['product_id']
    req=request('wfd_r1_local',sid,pid,['amount','label'],page_size=2,max_scan_bytes=16_777_216)
    query=ProductQuery(service)
    with monkeypatch.context() as context:
        context.setattr(service,'_query_batches_supported',lambda **kwargs:False)
        first=query.execute(req)
        second=query.execute({**req,'cursor':first['page']['next_cursor']})
    monkeypatch.setattr(service,'read',lambda *args,**kwargs:pytest.fail('tabular entered full reader'))
    for expected,query_req in [(first,req),(second,{**req,'cursor':first['page']['next_cursor']})]:
        actual=query.execute(query_req)
        for value in (expected,actual):value.pop('budget')
        assert actual==expected
    assert [row['record_ref']['logical_key'] for row in first['rows']]==['z','n']
    assert first['rows'][0]['values']['amount']['value']=='9007199254740993.12345678'
    with pytest.raises(ProductQueryError,match='Cursor is bound'):
        query.execute({**req,'fields':['label'],'cursor':first['page']['next_cursor']})


def test_cumulative_unrelated_metadata_uses_truthful_target_page_budget_and_keeps_damage_gates(tmp_path,monkeypatch):
    service=make_data_service(tmp_path)
    output=scalar_output('large','tabular.budget.unrelated','1')
    template=output['payload']['rows'][0]
    output['payload']['rows']=[{**copy.deepcopy(template),'business_key':str(i)+'x'*400} for i in range(3500)]
    first=service.submit(submit_request([output],'large'))
    assert first['state']=='published_formal',first
    result=service.submit(submit_request([tabular_output()],'target',parent=first['snapshot_id']))
    assert result['state']=='published_formal',result
    sid,pid=result['snapshot_id'],result['output_results'][0]['product_id']
    query=ProductQuery(service);req=request('wfd_r1_local',sid,pid,['amount'],page_size=2,max_scan_bytes=16_777_216)
    with monkeypatch.context() as context:
        context.setattr(service,'_query_batches_supported',lambda **kwargs:False)
        with pytest.raises(ProductQueryError) as error:query.execute(req)
        assert error.value.code=='SCAN_BUDGET_EXCEEDED'
    actual=query.execute(req)
    budget=actual['budget']
    assert budget['required_scan_bytes']<=16_777_216
    assert budget['verification_file_count']==1 and budget['candidate_rows']==4
    assert budget['scope']=='fixed_product_pages_with_snapshot_metadata'
    assert budget['read_plan']['selected_snapshot']['metadata_reads']==2
    assert budget['read_plan']['selected_snapshot']['contract_metadata_bytes']>0
    with monkeypatch.context() as context:
        context.setattr(service,'read_product_page',lambda *args,**kwargs:pytest.fail('budget failure reached payload'))
        with pytest.raises(ProductQueryError) as error:
            query.execute({**req,'max_scan_bytes':budget['required_scan_bytes']-1})
        assert error.value.code=='SCAN_BUDGET_EXCEEDED'
    snapshot=service.engine.read_snapshot(sid)
    entry=next(entry for entry in snapshot['files'] if entry['product_id']==pid)
    path=service.root/entry['file_relpath'];path.write_bytes(path.read_bytes()+b'corrupt-target')
    with pytest.raises(ProductQueryError) as error:query.execute(req)
    assert error.value.code=='CHECKSUM_MISMATCH'
