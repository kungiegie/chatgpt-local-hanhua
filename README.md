# 已更新至26年10月30日
# 压缩包目录如内容如下：
- CodexZhLocal.js
- 启动Codex中文.bat

# QQ群二维码，有问题可前往此QQ群进行询问


<img width="337" height="599" alt="output" src="https://github.com/user-attachments/assets/0b5eb30e-78d5-444d-b52c-73d75c78796e" />



# Codex 中文界面（免梯子）· 部署包

把这个文件夹整个拷贝到朋友的电脑上（随便放哪都行，比如桌面）。只需 **3 个文件**。

## 文件清单

| 文件                | 作用                                |
| ----------------- | --------------------------------- |
| `启动Codex中文.bat`   | 双击运行的一键启动器（自动检测安装路径、自动开调试端口、注入中文） |
| `CodexZhLocal.js` | 注入器本体（无需安装任何依赖，用系统自带 Node 运行）     |
| `README.md`       | 本说明                               |

## 朋友电脑需要提前装好

1. **Codex / ChatGPT 桌面版**（Microsoft Store 装 `OpenAI Codex`）—— 已装可跳过。
2. **Node.js**（必装）—— <https://nodejs.org/> 下载 **LTS 版本**，一路「下一步」装完即可。

## 操作步骤（朋友电脑上）

1. 把本文件夹拷过去（可用 U 盘 / 微信 / 网盘传）。
2. 后台退出Codex，**双击** `启动Codex中文.bat`。
3. 脚本自动注入并重载，日志出现中文关键词、`enHits:0` 即成功。
4. 当运行.bat弹出显示"按任意键退出"时再退出弹窗。
5. 以后再次启动codex时仍然需要运行.bat启动，.bat会自动检查codex路径无需担心。
6. 可以将.bat创建快捷方式到桌面作为以后的codex的启动方式

## 常见问题

* **提示「未检测到 Node.js」** → 先去装 Node.js（见上），装完重新双击。
* **提示「未找到 OpenAI.Codex 安装路径」** → 说明 Codex 没装或包名不同。先装好桌面版再运行；若仍报错，手动设置环境变量：
  ```
  set CODEX_MSIX_ROOT=C:\Program Files\WindowsApps\OpenAI.Codex_26.1013.3656.0_x64__2p2nqsd0c76g0
  ```
  （路径里的版本号以你电脑实际安装的为准，用 PowerShell 查：`Get-AppxPackage OpenAI.Codex | Select InstallLocation`）
* **想还原成英文** → 在 Codex 里删掉本地缓存目录（`...\LocalCache\Roaming\Codex\web\Codex\Default\Local Storage`）或重装应用即可。

## 原理（简要）

主界面语言由 Statsig 远程配置 layer `72216192` 的 `enable_i18n` 门控：离线时默认关闭→英文。本工具通过 CDP 调试接口在应用内部直接把该层强制设为 `enable_i18n:true, locale_source:SYSTEM`，并写入本地缓存，冷启动自动恢复，因此免梯子也能保持中文。中文语言包本来就在应用本地，只差这个开关。
