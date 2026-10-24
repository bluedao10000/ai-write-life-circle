import { writeFile } from 'node:fs/promises'
import { crc32, deflateRawSync } from 'node:zlib'

const entries = [
  ['mimetype', 'application/epub+zip', 0],
  [
    'META-INF/container.xml',
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    8,
  ],
  [
    'OEBPS/content.opf',
    '<package version="3.0"><metadata><title>合成导入作品</title><creator>测试作者</creator><dc:language xmlns:dc="http://purl.org/dc/elements/1.1/">zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    8,
  ],
  [
    'OEBPS/nav.xhtml',
    '<html><body><nav type="toc"><ol><li><a href="a.xhtml">第一章</a></li><li><a href="b.xhtml">第二章</a></li></ol></nav></body></html>',
    8,
  ],
  [
    'OEBPS/a.xhtml',
    '<html><body><h1>第一章</h1><p>合成第一章正文，用于真实浏览器导入回归。</p></body></html>',
    8,
  ],
  [
    'OEBPS/b.xhtml',
    '<html><body><h1>第二章</h1><p>合成第二章正文，用于确认完整作品持久化。</p></body></html>',
    8,
  ],
]

const uint16 = (value) => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}
const uint32 = (value) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

const central = []
const local = []
let offset = 0
for (const [name, content, method] of entries) {
  const filename = Buffer.from(name)
  const raw = Buffer.from(content)
  const data = method === 8 ? deflateRawSync(raw) : raw
  const checksum = crc32(raw)
  const header = Buffer.concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(0x0800),
    uint16(method),
    uint16(0),
    uint16(0),
    uint32(checksum),
    uint32(data.length),
    uint32(raw.length),
    uint16(filename.length),
    uint16(0),
  ])
  local.push(header, filename, data)
  central.push(
    Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0x0800),
      uint16(method),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(data.length),
      uint32(raw.length),
      uint16(filename.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
    ]),
    filename,
  )
  offset += header.length + filename.length + data.length
}

const directory = Buffer.concat(central)
const end = Buffer.concat([
  uint32(0x06054b50),
  uint16(0),
  uint16(0),
  uint16(entries.length),
  uint16(entries.length),
  uint32(directory.length),
  uint32(offset),
  uint16(0),
])
await writeFile(
  process.argv[2],
  Buffer.concat([...local, directory, end]),
)
