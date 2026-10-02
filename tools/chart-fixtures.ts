/** Independently transcribed printed legend counts. Evaluation only: never imported by src. */
export const chartFixtures = [
  {
    file: '哥伦比亚图纸.png',
    grid: { offsetX: 82, offsetY: 257, cellW: 52, cellH: 52, cols: 101, rows: 90 },
    total: 9090,
    counts: parseCounts('C17:110 C10:71 C7:69 H2:195 C3:101 D3:686 D22:201 D15:1154 D4:250 C27:39 D11:197 D2:442 E19:82 E9:32 E22:13 E3:77 E20:10 E24:68 E2:213 D9:78 E17:479 C2:35 C4:37 C5:75 C6:7 C8:141 C9:34 C16:101 C20:86 C24:75 C25:2 C26:16 C29:11 D1:62 D5:106 D6:238 D7:480 D8:151 D10:437 D12:69 D13:91 D14:97 D16:35 D17:118 D18:182 D20:41 D21:92 D23:111 D24:125 D25:314 D26:56 E4:23 E7:86 E8:14 E13:22 E15:3 E18:94 F7:11 F21:2 H5:32 H6:155 H7:536 H8:46 H9:5 H19:42 M11:27'),
  },
  {
    file: '奥黛塔图纸.png',
    grid: { offsetX: 50, offsetY: 845, cellW: 50, cellH: 50, cols: 104, rows: 104 },
    total: 10816,
    counts: parseCounts('C7:7 C13:2106 C17:18 C25:7 C27:388 C29:1274 D1:1295 D2:10 D6:5 D7:13 D8:7 D10:66 D12:8 D15:37 D16:2030 D17:147 D18:4 D20:2 D23:16 D24:19 D25:84 D26:11 E15:216 E16:1385 E19:4 E22:4 E24:21 F20:14 G15:8 G16:123 H2:145 H6:177 H17:529 H18:404 M4:64 M7:21 M8:9 M12:138'),
  },
]

function parseCounts(text: string): Record<string, number> {
  return Object.fromEntries(text.split(' ').map((entry) => {
    const [code, count] = entry.split(':')
    return [code, Number(count)]
  }))
}
