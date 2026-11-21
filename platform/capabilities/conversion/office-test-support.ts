import { crc32 } from 'node:zlib';

/** Stored ZIP members for small synthetic native Office documents. */
export function zipOfficeParts(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, count = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path), data = Buffer.from(xml), crc = crc32(data), head = Buffer.alloc(30), directory = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(head, name, data); central.push(directory, name); offset += head.length + name.length + data.length; count++;
  }
  const directoryBytes = central.reduce((sum, entry) => sum + entry.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
