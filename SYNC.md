# 发布同步配置

源代码同步地址：
https://raw.githubusercontent.com/e4je/huayi-exam-helper/main/huayi-exam-helper.user.js

在脚本站 8630 的管理/同步设置中填入该地址并保存。Webhook 地址必须由该站点的同步设置提供，不能使用脚本展示页地址。

取得专用 Webhook 地址后，在 GitHub 仓库 Settings → Webhooks → Add webhook 中按脚本站要求设置 Payload URL、Content type 和 Secret，通常只订阅 push。不要把含密钥的 Webhook 地址提交到仓库。

更新时修改脚本并递增 @version，提交到 main。浏览器已安装脚本的更新检查由脚本管理器负责，Webhook 同步并不等于所有浏览器立即更新。
