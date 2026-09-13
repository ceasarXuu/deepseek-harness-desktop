# Agent Note：为打包后的 harness 所启动的二进制返回可启动的路径

Status: implemented

[English](2026-09-13-spawnable-packaged-binary-paths.md) | 中文

## 问题

已安装的桌面应用中有两处启动点失败，原因相同：它们手里的路径穿过闭包归档，而不是指向一个文件。

`glob` 与 `grep` 每次调用都失败，报 `glob could not start its search command (ripgrep launch failed)`。`@vscode/ripgrep` 在模块求值时一次性解析它的平台包并导出该路径，于是搜索工具拿到的是 `<Resources>/harness.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`。

打开终端则以 `posix_spawnp failed` 失败。`node-pty` 在它所加载的 prebuild 旁边定位 `spawn-helper`，那同样是归档内的路径。

两种失败都没有点出路径问题，因为 Electron 改写了 `fs`：读取归档声明为 unpacked 的文件会落到 `<archive>.unpacked`，因此两个二进制在磁盘上都存在、可读、且带可执行位。进程启动不经过这层改写——操作系统拿到的是一个父级为文件的路径，以 `ENOTDIR` 失败。

用打包应用自带的 Electron 二进制以 Node 方式重入实测，逐条路径、逐个二进制：

| 启动对象 | 结果 |
|---|---|
| 归档内的 ripgrep 路径 | `ENOTDIR` |
| 该路径对应的 unpacked 兄弟文件 | `ripgrep 15.0.0 (rev 3a612f88b8)` |
| 归档内的 spawn-helper 路径 | `posix_spawnp failed` |
| 该路径的 unpacked 兄弟文件，经 `DSH_NODE_PTY_SPAWN_HELPER` 指明 | PTY 正常打开并读回命令输出 |

两种情形下产物都是对的。[`desktop/docs/releases/v0.0.1/packaging.md`](../../../../desktop/docs/releases/v0.0.1/packaging.md) 要求这些文件都解包在 `asar` 之外，闭包构建也确实把它们放在那里；只是没有任何一方按真正被启动的那条路径去读文件。

## 决策

harness 启动的二进制通过两条杠杆中能够抵达它的那一条，拿到真实路径。

**由 harness 自己解析出的路径，在解析处解包。** 当被打包的模块解析出的路径位于 `<name>.asar` 归档之内、且同一相对路径在 `<name>.asar.unpacked` 下存在时，`resolveRgPath()` 返回那个兄弟文件；其余路径原样返回。该规则即 [`search-core.ts`](../../../../packages/fs/tool-fs-search/src/search-core.ts) 中的 `executablePath()`，应用在首次读取惰性解析出的平台路径处。规则属于解析函数，因为调用方启动的正是它返回的值，而只有本包知道某个平台包是被解析出来的、而不是被点名的。

**由依赖自行算出的路径，由启动器指明。** `node-pty` 依据自身在闭包中的模块位置推导 helper 路径，那里没有任何 harness 代码去解析它；唯一的杠杆是被打过补丁的加载器会优先读取的 `DSH_NODE_PTY_SPAWN_HELPER`（见 [`patches/node-pty@1.1.0.patch`](../../../../patches/node-pty@1.1.0.patch)），因此由 shell 在它启动的子进程上设置该变量，与它在那里已经陈述的其他安装事实（`DSH_HOME`、`DSH_DESKTOP_VERSION`）并列。该变量只在 unpacked helper 确实存在时设置，因为开发期运行从散文件闭包启动、路径本就是真实的，而在那里指向一个不存在的文件会让每个终端都像归档路径那样失败。

产物本身不变。归档布局、归档的解包规则、闭包 manifest，以及[桌面组合](../architecture/2026-09-12-desktop-application-composition.md)都维持原样，闭包如何发布仍只由 desktop 子树决定。

## 备选方案

**把持有这些二进制的包放在归档旁边而不是归档里。** 就 ripgrep 而言实测可行：包不在归档中时，从归档内模块发起的解析会走出归档、返回真实路径，该路径可启动。否决原因：这样正确性就依赖解析在一个没有该包条目的归档处继续向外走，而且之后每个二进制都要重复一次同样的搬迁，而不是每条杠杆一条规则。

**在启动边界改写路径。** 否决：subprocess seam 拿到的是已经成形的 argv，并不解释它，因此改写只能发生在 provider 内部——那会让它对所有 spawn 静默生效，包括路径本就真实的那些——或由启动器去 patch `child_process`，而那种做法对 seam 和对产生该值的解析过程都是不可见的。它也够不到从原生代码启动的 `node-pty`。

**让 vendored 的 `node-pty` 补丁改写本归档的名字。** 否决：补丁将带上一条由它之外的目录布局决定的规则，而补丁的第二个使用者会继承第一个使用者的命名。

**首次启动时把闭包解包成真实目录。** 否决：它以首次运行的解包开销、磁盘上的第二份闭包副本、以及运行期必须可写的闭包为代价，换取两条杠杆就能吸收的缺陷。

**回到以散文件形式携带闭包。** 那正是归档取代掉的布局，取代它的理由依然成立：安装会在拷贝任何文件之前枚举整个包内的文件，散文件形式的闭包会让用户付出归档所消除的那段等待。

## 影响

**收益**：搜索与终端在打包应用中均可用，闭包构建的解包规则也真正产生它注释里声称的效果——文件在归档之外，*并且*被启动的路径能抵达它们。任何其他把 harness 打包进归档的部署同样受益。

**代价**：一个 harness 包从此带上了一条它原先没有的打包约定，shell 也就它所发布的安装多陈述了一条事实。路径不含归档时解析规则空转；环境变量只在 unpacked 文件存在处设置。

## 测试

[`rg-unpacked.spec.ts`](../../../../packages/fs/tool-fs-search/tests/rg-unpacked.spec.ts) 固定了三种解析结果：归档内路径且 unpacked 兄弟文件存在时解析为兄弟文件；归档内路径但兄弟文件缺失时原样返回；路径不含归档时原样返回。每种情形各自加载一份模块实例，因为该解析按进程记忆化。

对已安装应用实测：闭包自身的 `resolveRgPath()` 返回 `<app>/Contents/Resources/harness.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`，启动该文件输出 `ripgrep 15.0.0`；而那个以 `posix_spawnp failed` 失败的同一个 `node-pty` 加载项，在该变量指明 unpacked helper 后能打开 PTY 并读回 `/bin/echo pty-ok`。

第二条杠杆没有自动化测试：它是 shell 在自身启动的子进程上设置的变量，只有打包应用会走到。包装文档的原生产物表把它的两端一并陈述。
