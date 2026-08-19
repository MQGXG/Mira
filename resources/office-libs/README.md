# office-libs（动态 Office 库兜底）

`run_code`（Node 沙箱）脚本如需 `import 'docx' / 'xlsx' / 'pptxgenjs'` 免下载使用，
把三个库及其依赖树装到此目录：

```powershell
npm install docx xlsx pptxgenjs --prefix resources\office-libs --no-save
```

- 运行时探测链：`process.resourcesPath/office-libs/node_modules`（打包分发）→ 项目根 `resources/office-libs/node_modules`（开发环境）。
- 目录缺失时 `run_code` 优雅降级（脚本仍可零库运行），officecli_* 工具不受影响。
- `electron-builder.yml` 的 extraResources 引用了本目录；打包前若未生成库，
  本 README 作为占位文件保证目录存在（空库打包无害）。