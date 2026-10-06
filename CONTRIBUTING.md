# 参与贡献 · Contributing

感谢你愿意一起做「拼豆辅助」！这个文档说明我们怎么协作，看完就能开工。

---

## 一、先跑起来

```bash
npm install
npm run dev          # 开发模式，http://127.0.0.1:5178
```

改完代码，**提交 PR 之前必须**跑：

```bash
npm test             # = npm run build && npm run verify
```

**全绿才算完。** 这是唯一的硬门槛。

想单独跑某一项验证：

```bash
npm run verify          # 主验证
npm run verify:ocr      # 色号识别
npm run verify:charts   # 图纸解析
npm run smoke           # 冒烟
npm run mobile          # 移动端
npm run bench           # 性能
```

---

## 二、怎么提改动

**main 分支有保护，不能直接推。** 一律走分支 + PR：

```bash
git checkout -b feat/你做的事        # 从最新的 main 切
# ...改代码...
git add -A
git commit -m "说清楚「为什么」这么改"
git push -u origin feat/你做的事
```

然后在 GitHub 上开 **Pull Request** 指向 `main`。

### 分支命名

| 前缀 | 用途 |
| --- | --- |
| `feat/xxx` | 新功能 |
| `fix/xxx` | 修 bug |
| `refactor/xxx` | 重构，不改行为 |
| `docs/xxx` | 只改文档 |
| `perf/xxx` | 性能优化 |

### 提交信息

**写清楚「为什么」，不只是「改了什么」。** 单纯写「修复 bug」等于没写。

好例子（就照现在仓库里的风格）：

```
按方案第 1 步：加「原样像素」打印，把障碍范围缩小到「比较/归类」这一步
修颜色缓存碰撞：按完整 24 位缓存，结果不再依赖处理顺序
```

---

## 三、PR 的规矩

开 PR 时**填模板里的自查清单**，尤其这两条：

- [ ] 本地 `npm test` 全绿
- [ ] 说明改动的**动机**（不只是现象）

CI 会自动跑 `build + verify`，**绿了才会被合**。

**同一个文件尽量别两个人同时改** —— 分工按模块走，谁的活谁负责。

---

## 四、分工

| 范围 | 负责 |
| --- | --- |
| 识别 / 网格校准 / 色号读取 | @VectorNova |
| （待定，加人时补） | |

**动到别人负责的模块前，先在 Issue 或群里说一声。**

---

## 五、许可（重要）

本项目是 **AGPL-3.0**，而且**必须**保持 AGPL —— 因为派生自
[Zippland/perler-beads](https://github.com/Zippland/perler-beads)（同为 AGPL-3.0）。

这意味着：

- 你贡献的代码**自动以 AGPL-3.0 授权**
- 谁改了并**公开部署**（网页也算"通过网络提供"），就**必须公开源码**
- 不能改成闭源再发布或售卖
- 自己用、自己改、自己跑，**完全自由**

提交 PR 即表示你同意以上条款。

---

## 六、设计原则

- **数据只留本机浏览器**（这是产品承诺，别引入上传/追踪）
- 依赖要克制（现在只有 3 个运行时依赖，守住这条线）
- 注释和提交信息用中文，跟现有代码一致
- 移动端和桌面端都要能看（`npm run mobile`）
