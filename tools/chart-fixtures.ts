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
  {
    file: '海边灯塔.jpg',
    // 坐标栏止于第60行；底部两排图例位于主网格之外。
    grid: { offsetX: 50.7405, offsetY: 50.5989, cellW: 33.1880, cellH: 33.1911, cols: 62, rows: 60 },
    total: 2674,
    counts: parseCounts('B9:29 B11:65 B25:36 B32:192 C3:64 C6:645 C10:52 C13:82 C20:294 C24:271 C26:214 F19:31 G7:28 G11:55 G17:48 H1:28 H2:65 H6:24 H15:17 H18:207 H20:11 M3:6 M4:9 M6:39 M9:59 M12:28 M14:35 M15:40'),
  },
  {
    file: '奥黛塔（侧脸）.png',
    grid: { offsetX: 82, offsetY: 276, cellW: 52, cellH: 52, cols: 102, rows: 102 },
    total: 10404,
    // 原图确实列了80色，包含只有一粒的E19，不能按稀有程度删色。
    counts: parseCounts('C3:139 C5:13 C7:65 C8:623 C9:51 C12:29 C13:1064 C14:74 C16:223 C20:119 C21:249 C23:69 C24:335 C27:331 C28:69 C29:590 D1:722 D2:236 D3:517 D4:365 D5:5 D6:10 D7:18 D8:7 D9:11 D10:341 D11:165 D12:7 D14:15 D15:432 D16:248 D17:98 D18:6 D19:3 D21:4 D22:292 D24:457 D25:20 D26:2 E2:12 E3:3 E8:66 E9:4 E11:8 E17:32 E18:14 E19:1 E20:19 E21:14 E22:82 E23:40 E24:410 F6:15 F7:4 F11:3 F21:34 G8:56 G17:20 H2:228 H3:50 H4:65 H5:32 H6:373 H7:226 H8:2 H10:55 H14:12 H15:23 H16:14 H17:7 H18:53 H19:12 H20:46 H21:9 H22:7 M3:47 M10:182 M11:2 M12:69 M15:29'),
  },
]

function parseCounts(text: string): Record<string, number> {
  return Object.fromEntries(text.split(' ').map((entry) => {
    const [code, count] = entry.split(':')
    return [code, Number(count)]
  }))
}
