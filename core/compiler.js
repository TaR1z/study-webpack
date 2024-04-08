const { SyncHook } = require("tapable");
const path = require("path");
const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const t = require("@babel/types");
const { toUnixPath, tryExtensions, getSourceCode } = require("../utils");

class Compiler {
  constructor(options) {
    this.options = options;
    // 相对根路径
    this.rootPath = this.options.context || toUnixPath(process.cwd());
    this.hooks = {
      // 开始编译时的钩子
      run: new SyncHook(),
      // 输出asset 到 output 目录之前执行（写入文件之前）
      emit: new SyncHook(),
      // 在compilation 完成时执行 全部完成编译执行
      done: new SyncHook(),
    };
    // 保存所有入口模块对象
    this.entries = new Set();
    // 保存所有依赖模块对象
    this.modules = new Set();
    // 所有的代码块对象
    this.chunks = new Set();
    // 存放本次产出的文件对象
    this.assets = new Set();
    // 存放本次编译所有产出的文件名
    this.files = new Set();
  }

  // run方法启动编译
  // 同时run 方法接受外部传递的callback
  run(callback) {
    // 当调用run方式时，触发开始编译的plugin
    this.hooks.run.call();
    // 获取入口配置对象
    const entry = this.getEntry();
    // 编译入口文件
    this.buildEntryModule(entry);
    // 导出列表，之后每个chunk转换称为单独的文件加入到输出列表assets中
    this.exportFile(callback);
  }

  exportFile(callback) {
    const output = this.options.output;
    // 根据chunks生成assets内容
    this.chunks.forEach((chunk) => {
      const parseFileName = output.filename.replace("[name]", chunk.name);
      // assets中 { main.js : 生成字符串代码 }
      this.assets[parseFileName] = getSourceCode(chunk);
    });
    // 调用Plugin emit钩子
    this.hooks.emit.call();
    // 先判断目录是否存在， 存在直接fs.write 不存在则创建
    if (!fs.existsSync(output.path)) {
      fs.mkdirSync(output.path);
    }
    // files中保存所有的生成文件名
    this.files = Object.keys(this.assets);
    // 将assets中的内容生成打包文件 写入文件系统中
    Object.keys(this.assets).forEach((fileName) => {
      const filePath = path.join(output.path, fileName);
      fs.writeFileSync(filePath, this.assets[fileName]);
    });
    // 结束之后出发钩子
    this.hooks.done.call();
    callback(null, {
      toJson: () => {
        return {
          entries: this.entries,
          module: this.modules,
          files: this.files,
          chunks: this.chunks,
          assets: this.assets,
        };
      },
    });
  }

  buildEntryModule(entry) {
    Object.keys(entry).forEach((entryName) => {
      const entryPath = entry[entryName];
      const entryObj = this.buildModule(entryName, entryPath);
      this.entries.add(entryObj);
      // 根据当前入口文件和模块的相互依赖关系，组装成为一个个包含当前入口所有依赖模块的chunk
      this.buildUpChunk(entryName, entryObj);
    });
  }

  // 根据入口文件和依赖模块组装chunks
  buildUpChunk(entryName, entryObj) {
    const chunk = {
      // 每个入口文件作为一个chunk
      name: entryName,
      // entry编译后的对象
      entryModule: entryObj,
      // 寻找与当前entry有关的所有module
      modules: Array.from(this.modules).filter((i) => {
        return i.name.includes(entryName);
      }),
    };
    // 将chunk添加到this.chunks中去
    this.chunks.add(chunk);
  }

  // 模块编译方法
  buildModule(moduleName, modulePath) {
    // 1. 读取文件原始代码
    const originSourceCode = (this.originSourceCode = fs.readFileSync(
      modulePath,
      "utf-8"
    ));
    // moduleCode为修改后的代码
    this.moduleCode = originSourceCode;
    // 2. 调用loader进行处理
    this.handleLoader(modulePath);
    // 3. 调用webpack进行模块编译 获得最终的module对象
    const module = this.handleWebpackCompiler(moduleName, modulePath);
    // 4.返回对应的module
    return module;
  }

  // 调用webpack进行模块编译
  handleWebpackCompiler(moduleName, modulePath) {
    // 将当前模块相对于项目启动根目录计算出相对路径 作为模块ID
    const moduleId = "./" + path.posix.relative(this.rootPath, modulePath);
    // 创建模块对象
    const module = {
      id: moduleId,
      // 依赖模块绝对路径地址
      dependencies: new Set(),
      // 该模块入口文件
      name: [moduleName],
    };
    // 调用babel分析代码
    const ast = parser.parse(this.moduleCode, {
      sourceType: "module",
    });
    // 深度优先 遍历语法Tree
    traverse(ast, {
      // 当遇到require语句时
      CallExpression: (nodePath) => {
        const node = nodePath.node;
        if (node.callee.name === "require") {
          // 获取源代码中引入模块相对路径
          const requirePath = node.arguments[0].value;
          // 寻找模块绝对路径 当前模块路径+require()对应相对路径
          const moduleDirName = path.posix.dirname(modulePath);
          const absolutePath = tryExtensions(
            path.posix.join(moduleDirName, requirePath),
            this.options.resolve.extensions,
            requirePath,
            moduleDirName
          );
          // 生成moduleID - 针对 根路径的模块ID 添加进入新的依赖模块路径
          const moduleId =
            "./" + path.posix.relative(this.rootPath, absolutePath);
          // 通过babel修改源代码中require变成__webpack_require__语句
          node.callee = t.identifier("__webpack_require__");
          // 修改源代码中require语句引入的模块 全部修改为相对路径来处理
          node.arguments = [t.stringLiteral(moduleId)];
          // 转换成ids的数组 好处理
          const alreadyModules = Array.from(this.modules).map((i) => i.id);
          if (!alreadyModules.includes(moduleId)) {
            // 为当前模块添加require语句造成的依赖（内容为相当于根路径的模块ID）
            module.dependencies.add(moduleId);
          } else {
            // 已经存在的话 虽然不进行添加进入模块编译 但是仍要更新这个模块依赖的入口
            this.modules.forEach((value) => {
              if (value.id === moduleId) {
                value.name.push(moduleName);
              }
            });
          }
        }
      },
    });
    // 遍历结束根据AST生成新的代码
    const { code } = generator(ast);
    // 为当前模块挂载新的生成代码
    module._source = code;
    // 递归依赖深度遍历 存在依赖模块则进入
    module.dependencies.forEach((dependency) => {
      const depModule = this.buildModule(moduleName, dependency);
      // 将编译后的任何依赖模块对象加入到modules对象中去
      this.modules.add(depModule);
    });
    // 返回当前模块对象
    return module;
  }

  // 匹配loader处理
  handleLoader(modulePath) {
    const matchLoaders = [];
    // 1. 获取传入的loader规则
    const rules = this.options.module.rules;
    rules.forEach((loader) => {
      const testRule = loader.test;
      if (testRule.test(modulePath)) {
        if (loader.loader) {
          // 仅考虑loader { test: /\.js$/, use:['babel-loader'] }, { test: /\.js$/, loader:'babel-loader' }
          matchLoaders.push(loader.loader);
        } else {
          matchLoaders.push(...loader.use);
        }
      }
      // 2. 倒序执行loader传入源代码
      for (let i = matchLoaders.length - 1; i >= 0; i--) {
        // 目前我们外部仅支持传入绝对路径的loader模式
        // require 引入对应loader
        const loaderFn = require(matchLoaders[i]);
        // 通过loader同步处理每一次编译的moduleCode
        this.moduleCode = loaderFn(this.moduleCode);
      }
    });
  }

  // 获取入口文件路径
  getEntry() {
    let entry = Object.create(null);
    const { entry: optionEntry } = this.options;
    if (typeof optionEntry === "string") {
      entry["main"] = optionEntry;
    } else {
      entry = optionEntry;
    }
    // 将Entry转换绝对路径
    Object.keys(entry).forEach((key) => {
      const value = entry[key];
      if (!path.isAbsolute(value)) {
        entry[key] = toUnixPath(path.join(this.rootPath, value));
      }
    });
    return entry;
  }
}

module.exports = Compiler;
