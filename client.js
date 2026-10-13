// dsh-rewind —— 客户端插件（桌面端 Web UI 客户端插件协议）
// 协议：window.__ModuleLoader__.load({ id, factory(require) => module.exports })
// module.exports 必须含 apply 方法（与宿主端 Cordis 插件同构），纯脚本、禁止 ESM export。
// 本插件的回滚面板由服务端 index-inject 注入（见 lib/webui.js），
// 此处注册空客户端插件，保证桌面端 client 插件聚合器能正常激活本包。
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-rewind',
    factory: function () {
      var module = { exports: {} }
      var exports = module.exports
      // 面板与样式由 webserver/index-inject 提供；客户端无需逻辑。
      exports.apply = function () {}
      return module.exports
    },
  })
}
