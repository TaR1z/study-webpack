const Compiler = require("./compiler");

function webpack(options) {
  // 合并参数
  const mergeOptions = _mergeOptions(options);
  // 创建compiler对象
  const compiler = new Compiler(mergeOptions);
  // 加载插件
  _loadPlugin(options.plugins, compiler);
  return compiler;
}

function _mergeOptions(options) {
  const shellOptions = process.argv.slice(2).reduce((option, argv) => {
    // argv -> --mode=production
    const [key, value] = argv.split("=");
    if (key && value) {
      const parseKey = key.slice(2);
      option[parseKey] = value;
    }
    return option;
  }, {});

  return {
    ...options,
    ...shellOptions,
  };
}

function _loadPlugin(plugins, compiler) {
  if (plugins && Array.isArray(plugins)) {
    plugins.forEach((plugin) => {
      plugin.apply(compiler);
    });
  }
}

module.exports = webpack;
