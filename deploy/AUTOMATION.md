# 自动部署

GitHub Actions 在 PR 中运行 Ruff、后端测试和前端构建。只有提交进入当前默认分支
`feat/first-release` 后才部署；也可从 Actions 手动重跑该分支。更换默认分支时需同时修改
workflow 的触发条件、部署条件与最新提交检查。

## 一次性配置

现有 Ubuntu 服务器需完成 `install.sh`，账本已初始化、`config.env` 指向实际账本。
先核验 SSH 主机公钥；不要在 CI 通过不校验的 ssh-keyscan 临时信任服务器。
在仓库 production environment 配置下列 secrets：

- `DEPLOY_HOST`：ECS 公网地址。
- `DEPLOY_USER`：部署用户。需要写入自己 home 下 releases/ 和执行升级脚本的 sudo 权限。
- `DEPLOY_SSH_KEY`：专门用于这个私有仓库的部署私钥。
- `DEPLOY_KNOWN_HOSTS`：已通过控制台核验的 SSH known_hosts 完整记录。

部署身份可以更新运行程序，因此等同于信任该仓库的合并权限。不要复用其他项目私钥。
这些值只放 GitHub Secrets；不得提交私钥、config.env、真实账本、备份或登录密码。
此流程不自动购买服务或修改安全组、域名、HTTPS 配置。

## 更新行为

构建包仅包含 backend、scripts、deploy 和 web/dist。服务器在 releases 下建立独立程序及
Python 环境，依赖安装成功后用 SQLite backup API 备份现有账本，短暂停服切换链接。
健康接口和首页都通过才算成功；失败自动切回旧程序和旧 Python 环境，保留账本原样。
并发发布串行处理，旧提交不得覆盖已进入默认分支的新提交。

升级脚本只适用于可向后兼容的数据库改动。破坏性迁移必须单独评审，不能依赖程序回退恢复
数据。备份留在 /opt/mingzhang/backups/predeploy-*.sqlite3；部署备份不自动删除。健康检查通过后清理托管 release，保留最近 5 版（包含当前版与升级前的回退版）；app 和 venv 所指目录都受保护，手工命名目录、符号链接及 legacy 目录不清理。失败部署不触发清理。成功后删除此次 home 下的上传压缩包与解压目录；失败时保留排查证据。清理失败会输出警告，不回退已健康的新版本。

首次手工更新：解压可信构建包，进入包目录后执行：

```sh
sudo bash deploy/upgrade.sh <40位Git提交SHA>
```

如需手工回退，停止服务，把 /opt/mingzhang/app、/opt/mingzhang/venv 两个符号链接同时指向
同一旧 release 的 app、venv，再启动并验证。不要覆盖或自动还原账本。

## 生效范围

网页和使用云端地址的 Mac 客户端都加载同一份服务端前端，通常刷新即可更新。
Electron 主程序、图标及原生菜单改动仍需另行打包客户端。

客户端代码或打包流程发生变化时，Actions 会分别在 macOS 和 Windows runner 上生成安装包，
部署完成后发布到固定的 `/downloads/` 地址并写入 `latest.json`。普通网页或后端修改不会重复
打包客户端。安装包只作为本次部署的临时 artifact，部署结束立即删除；若清理步骤未执行，
GitHub 也会在 1 天后删除。客户端通过 HTTPS 读取清单，发现更高版本后在左下角显示更新按钮。
ICP备案和 HTTPS 云端入口完成前，服务器更新成功不等于公网可访问。
