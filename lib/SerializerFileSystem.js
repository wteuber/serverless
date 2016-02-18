'use strict';

const SError   = require('./Error'),
  SUtils       = require('./utils/index'),
  fs           = require('fs'),
  glob         = require('glob'),
  async        = require('async'),
  _            = require('lodash'),
  mkdirp       = require('mkdirp'),
  BbPromise    = require('bluebird');

// NOTE: Useful methods like "getFilePath()" were left out since we do not want the other classes to inherit this and be build reliance upon it.
// The asset classes should not have anything specific to file paths, except for a single filePath attribute in their config, which is set ONLY by the SerializerFileSystem

class SerializerFileSystem {

  constructor(S) {
    this._S           = S;
    this._projectPath = S.config.serializer.projectPath;
  }

  serialize(asset) {
    return this['serialize' + asset._class].apply(_.toArray(arguments));
  }

  deserialize(asset) {
    return this['deserialize' + asset._class].apply(_.toArray(arguments));
  }

  /**
   * Deserialize Project
   */

  deserializeProject(project) {

    let _this = this,
      projectContents;

    return BbPromise.try(function () {

        // Validate: Check project exists
        if (!_this._S.hasProject()) throw new SError('Project could not be loaded because no project path has been set on Serverless instance');

        // Load Project
        project = _.merge(project, SUtils.readFileSync(path.join(_this._projectPath, 's-project.json')));

        // Iterate through project contents
        projectContents = fs.readdirSync(_this._projectPath);
        return projectContents;
      })
      .each(function (c, i) {

        // Load Components
        if (SUtils.fileExistsSync(path.join(_this._projectPath, c, 's-component.json'))) {

          let component = new _this._S.classes.Component(_this._S, project, {
            filePath: path.join(_this._projectPath, c, 's-component.json')
          });

          return component.load()
            .then(function (instance) {
              project.setComponent(instance);
            });
        }
      })
      .then(function () {

        // Load Variables, Stages & Regions
        let variablesRootPath = path.join(_this._projectPath, '_meta', 'variables');

        if (SUtils.dirExistsSync(variablesRootPath)) {

          let variableFiles = fs.readdirSync(_this.getFilePath('_meta', 'variables'));

          return BbPromise.resolve(variableFiles)
            .each(function(variableFile) {

              // Skip unrelated and hidden files
              if (!variableFile || variableFile.charAt(0) === '.' || variableFile.indexOf('s-variables') == -1) return;

              // Parse file name to get stage/region
              let file = variableFile.replace('s-variables-', '').replace('.json', '');

              if (file === 'common') {

                // Load Variables
                let variables = new _this._S.classes.Variables(_this._S, {
                  filePath: path.join(variablesRootPath, variableFile)
                });

                return variables.load()
                  .then(function (instance) {
                    project._variables = instance;
                  });

              } else {

                file = file.split('-');

                if (file.length == 1) {

                  // Load Stage
                  let stage = new _this._S.classes.Stage(_this._S, {
                    filePath: path.join(variablesRootPath, variableFile)
                  });

                  return stage.load()
                    .then(function (instance) {
                      project.setStage(instance);
                    });

                } else if (file.length == 2) {

                  // Load Region
                  let stage = project.getStage(file[0]);

                  if (stage) {
                    let region = new _this._S.classes.Region(_this._S, stage, {
                      filePath: path.join(variablesRootPath, variableFile)
                    });

                    return region.load()
                      .then(function (instance) {
                        stage.setRegion(instance);
                      });
                  }
                }
              }
            });
        }
      })
      .then(function() {

        // Load Resources
        if (SUtils.fileExistsSync(path.join(_this._projectPath, 's-resources-cf.json'))) {

          let resources = new _this._S.classes.Resources(_this._S, stage, {
            filePath: path.join(_this._projectPath, 's-resources-cf.json')
          });

          return resources.load()
            .then(function (instance) {

              return globber(instance._config.filePath, 's-resources-cf.json')
                .each(function(path) {
                  instance.setModule(SUtils.readFileSync(path));
                })
                .then(function() {
                  project.setResources(instance);
                })
            });
        }
      })
      .then(function() {

        // Load Templates
        if (SUtils.fileExistsSync(path.join(_this._projectPath, 's-templates.json'))) {

          let templates = new _this._S.classes.Templates(_this._S, stage, {
            filePath: path.join(_this._projectPath, 's-templates.json')
          });

          return templates.load()
            .then(function (instance) {
              project._templates = instance;
            });
        }
      })
      .then(function () {
        return _this;
      });
  }

  /**
   * Serialize Project
   */

  serializeProject(project, options) {

    let _this   = this,
      serialize = [];

    return new BbPromise.try(function () {
      // Save Components
      return BbPromise.resolve(project.getAllComponents())
        .each(function (c) {
          serialize.push(c.save(options));
        });
    })
      .then(function() {
        // Save Stages
        return BbPromise.resolve(project.getStages())
          .each(function (s) {
            return s.save(options);
          });
      })
      .then(function () {

        // Save Variables, Resources & Templates
        serialize.push(project.getVariables().save());
        serialize.push(project.getTemplates().save());
        serialize.push(project.getResources().save());

        // Clone and remove properties saved in separate files
        let clone = project.toObject();
        if (clone.components) delete clone.components;
        if (clone.resources)  delete clone.resources;
        if (clone.stages)     delete clone.stages;
        if (clone.variables)  delete clone.variables;
        if (clone.templates)  delete clone.templates;

        // Save s-project.json
        serialize.push(SUtils.writeFile(_this.getFilePath('s-project.json'),
          JSON.stringify(clone, null, 2)));

        return BbPromise.all(serialize);
      })
      .then(function() { return _this; });
  }

  /**
   * Deserialize Component
   */

  deserializeComponent(component) {

    let _this   = this,
      componentDir;

    // Load component, then traverse component dirs to get all functions
    return BbPromise.try(function() {

        // Validate: Check project path is set
        if (!_this._S.hasProject()) throw new SError('Component could not be loaded because no project path has been set on Serverless instance');

        // Validate: Check component exists
        if (!SUtils.fileExistsSync(component._config.filePath)) {
          throw new SError('Component could not be loaded because it does not exist in your project');
        }

        componentDir = component._config.filePath.split(path.sep).slice(0, -1).join(path.sep);

        // Load Component
        component = _.merge(component, SUtils.readFileSync(component._config.filePath));
      })
      .then(function() {

        // Load Functions
        return globber(componentDir, 's-function.json')
          .each(function(path) {
            let func = new _this._S.classes.Function(_this._S, component, {
              filePath: path
            });
            return func.load()
              .then(function(instance) {
                // TODO: Check uniqueness of function name within the project and throw error if not unique
                component.functions[instance.name] = instance;
              });
          });
      })
      .then(function() {
        // Reset Runtime
        component.setRuntime( component.runtime );
        return component;
      });
  }

  /**
   * Serialize Component
   */

  serializeComponent(component, options) {

    let _this   = this,
      serialize = [];

    return new BbPromise.try(function () {
      // Save Functions
      if (options && options.deep) {
        return BbPromise.resolve(component.getAllFunctions())
          .each(function (f) {
            serialize.push(f.save(options));
          });
      }
    })
      .then(function () {

        // Save s-component.json
        serialize.push(SUtils.writeFile(component._config.filePath,
          JSON.stringify(component.get(), null, 2)));

        return BbPromise.all(serialize);
      })
      .then(function() { return _this; });
  }

  /**
   * Deserialize Function
   */

  deserializeFunction(func) {

    let _this   = this;

    // Load component, then traverse component dirs to get all functions
    return BbPromise.try(function() {

        // Validate: Check project path is set
        if (!_this._S.hasProject()) throw new SError('Function could not be loaded because no project path has been set on Serverless instance');

        // Validate: Check function exists
        if (!SUtils.fileExistsSync(func._config.filePath)) {
          throw new SError('Function could not be loaded because it does not exist in your project');
        }

        // Set Data
        func.set(SUtils.readFileSync(func._config.filePath));

      })
      .then(function() {

        // Get Templates
        return new BbPromise(function(resolve, reject) {
          let current = '.',
            templates = [];

          async.whilst(function () {
              return SUtils.fileExistsSync(path.join(_this._projectPath, current, 's-project.json'));
            },
            function (next) {
              if (SUtils.fileExistsSync(path.join(_this._projectPath, current, 's-templates.json'))) {
                templates.push(SUtils.readFileSync(path.join(_this._projectPath, current, 's-templates.json')));
              }
              current = path.join(current, '..');
              return next();
            },
            function (err) {
              if (err) reject(err);
              func._templates = _.merge(func._templates, current.reverse());
              return resolve();
            });
        });
      });
  }

  /**
   * Serialize Function
   */

  serializeFunction(func) {
    let _this   = this;

    // Load component, then traverse component dirs to get all functions
    return BbPromise.try(function() {

        // Validate: Check project path is set
        if (!_this._S.hasProject()) throw new SError('Function could not be saved because no project path has been set on Serverless instance');

        // Make function scaffolding, if does not exist
        if (!func._config.filePath || !SUtils.fileExistsSync(func._config.filePath)) {

          func._config.filePath = path.join(func.getComponent()._config.filePath, func.name);
          if (SUtils.fileExistsSync(func._config.filePath)) func._config.filePath = func._config.filePath + '-' + SUtils.generateShortId(3);

          // Create event.json
          SUtils.writeFile(path.join(func._config.fullPath, 'event.json'), '{}');
        }

      })
      .then(function() {
        return SUtils.writeFile(func._config.filePath,
          JSON.stringify(func.get({ deep: true }), null, 2));
      });
  }
}

module.exports = SerializerFileSystem;

/**
 * Globber
 * - Matches are sorted
 */

function globber(root, fileName) {
  return new BbPromise(function(resolve, reject) {
    return glob('**/' + fileName, {root: root}, function (err, files) {
      if (err) reject(err);
      resolve(files);
    });
  });
}