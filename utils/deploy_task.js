'use strict';

/*
 * grunt-aws-lambda
 * https://github.com/Tim-B/grunt-aws-lambda
 *
 * Copyright (c) 2014 Tim-B
 * Licensed under the MIT license.
 */

var path = require('path');
var fs = require('fs');
var AWS = require('aws-sdk');
var Q = require('q');
var arnParser = require('./arn_parser');
var dateFacade = require('./date_facade');

var deployTask = {};


deployTask._getLambda = function(grunt, options, callback) {
    var deploy_function = grunt.config.get('lambda_deploy.' + this.target + '.function');
    var deploy_arn = grunt.config.get('lambda_deploy.' + this.target + '.arn');

    var params = {
        FunctionName: (deploy_arn) ? deploy_arn : deploy_function
    };

    if(params.FunctionName === 'undefined')
        grunt.fail.warn("Must define `depoy_function` or `deloy_arn`...");

    this.lambda.getFunction(params, function (err, data) {
        if (err) {
            if (err.statusCode === 404) {
                grunt.log.warn('Unable to find lambda function ' + params.FunctionName + ', attempting to create it.');
                deployTask._createLambda(grunt, options, function(data) {
                    callback(data);
                });
            } else {
                grunt.log.error('AWS API request failed with ' + err.statusCode + ' - ' + err);
                grunt.fail.warn('Check your AWS credentials, region and permissions are correct.');
            }
        } else {
            callback(data);
        }
    });
}

/**
 * Creates a lambda function if it didn't already exist
 * @param grunt A grunt build system object
 * @param options The options object created inside the #getHandler function
 * @param callback A callback to invoke with the Lambda#createFunction response
 * @private
 */
deployTask._createLambda = function(grunt, options, callback) {
    var deploy_function = grunt.config.get('lambda_deploy.' + this.target + '.function');
    var deploy_arn = grunt.config.get('lambda_deploy.' + this.target + '.arn');
    var deploy_role = grunt.config.get('lambda_deploy.' + this.target + '.role');

    var _getLambdaRole = function(grunt, options, callback) {
        var params = {
            RoleName: deploy_role
        };

        deployTask.iam.getRole(params, function(err, data) {
            if(err) {
                grunt.fail.warn("Cannot create lambda because role `"+deploy_role+"` does not exist: " + err);
            } else {
                callback(data);
            }
        });
    }

    _getLambdaRole(grunt, options, function(data) {
        var params = {
            Code: {
                ZipFile: fs.readFileSync(grunt.config.get('lambda_deploy.' + deployTask.target + '.package'))
            },
            FunctionName: (deploy_arn) ? deploy_arn : deploy_function,
            Handler: options.handler,
            Role: data.Role.Arn,
            Runtime: 'nodejs4.3', /* required */
            MemorySize: options.memory,
            Publish: true,
            Timeout: options.timeout,
            VpcConfig: {
                SubnetIds : options.subnetIds,
                SecurityGroupIds : options.securityGroupIds
            }
        }

        deployTask.lambda.createFunction(params, function(err, data) {
            if(err) {
                grunt.fail.warn("Unable to create lambda function `"+params.FunctionName+"`: "+ err);
                return;
            }
            callback(data);
        });
    })
}



deployTask.getHandler = function (grunt) {

    return function () {
        deployTask.target = this.target;

        grunt.config.requires('lambda_deploy.' + this.target + '.package');

        var options = this.options({
            profile: null,
            RoleArn: null,
            accessKeyId: null,
            secretAccessKey: null,
            credentialsJSON: null,
            region: 'us-east-1',
            timeout: null,
            memory: null,
            handler: null,
            enableVersioning: false,
            aliases: null,
            enablePackageVersionAlias: false,
            subnetIds: null,
            securityGroupIds: null
        });

        if (options.profile !== null) {
            var credentials = new AWS.SharedIniFileCredentials({profile: options.profile});
            AWS.config.credentials = credentials;
        }

        if (options.RoleArn !== null) {
            AWS.config.credentials = new AWS.EC2MetadataCredentials({
                httpOptions: {timeout: 5000} // 5 second timeout
            });
            AWS.config.credentials = new AWS.TemporaryCredentials({
                RoleArn: options.RoleArn
            });
        }

        if (options.accessKeyId !== null && options.secretAccessKey !== null) {
            AWS.config.update({accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey});
        }

        if (options.credentialsJSON !== null) {
            AWS.config.loadFromPath(options.credentialsJSON);
        }

        AWS.config.update({region: options.region});

        if (typeof options.aliases === 'string') {
            options.aliases = [options.aliases];
        }

        var deploy_function = grunt.config.get('lambda_deploy.' + this.target + '.function');
        var deploy_arn = grunt.config.get('lambda_deploy.' + this.target + '.arn');
        var deploy_package = grunt.config.get('lambda_deploy.' + this.target + '.package');
        var package_version = grunt.config.get('lambda_deploy.' + this.target + '.version');
        var package_name = grunt.config.get('lambda_deploy.' + this.target + '.package_name');
        var archive_name = grunt.config.get('lambda_deploy.' + this.target + '.archive_name');

        if (deploy_arn === null && deploy_function === null) {
            grunt.fail.warn('You must specify either an arn or a function name.');
        }

        if (deploy_arn) {
            deploy_function = deploy_arn;
            var functionInfo = arnParser.parse(deploy_arn);
            if (functionInfo && functionInfo.region) {
                options.region = functionInfo.region;
            }
        }

        var done = this.async();

        deployTask.lambda = new AWS.Lambda({
            apiVersion: '2015-03-31'
        });
        deployTask.iam = new AWS.IAM({
            apiVersion: '2010-05-08'
        });

        var getDeploymentDescription = function () {
            var description = 'Deployed ';

            if (package_name) {
                description += 'package ' + package_name + ' ';
            }
            if (package_version) {
                description += 'version ' + package_version + ' ';
            }

            description += 'on ' + dateFacade.getHumanReadableTimestamp(new Date());

            if (archive_name) {
                description += ' from artifact ' + archive_name;
            }

            return description;
        };


        deployTask._getLambda(grunt, options, function(data) {

            var current = data.Configuration;
            var configParams = {};
            var version = '$LATEST';


            if (options.timeout !== null) {
                configParams.Timeout = options.timeout;
            }

            if (options.memory !== null) {
                configParams.MemorySize = options.memory;
            }

            if (options.handler !== null) {
                configParams.Handler = options.handler;
            }

            if (options.subnetIds !== null && options.securityGroupIds !== null) {
                configParams.VpcConfig = {
                    SubnetIds : options.subnetIds,
                    SecurityGroupIds : options.securityGroupIds
                };
            }

            var updateConfig = function (func_name, func_options) {
                var deferred = Q.defer();
                if (Object.keys(func_options).length > 0) {
                    func_options.FunctionName = func_name;
                    deployTask.lambda.updateFunctionConfiguration(func_options, function (err, data) {
                        if (err) {
                            grunt.fail.warn('Could not update config, check that values and permissions are valid');
                            deferred.reject();
                        } else {
                            grunt.log.writeln('Config updated.');
                            deferred.resolve();
                        }
                    });
                } else {
                    grunt.log.writeln('No config updates to make.');
                    deferred.resolve();
                }
                return deferred.promise;
            };

            var createVersion = function (func_name) {
                var deferred = Q.defer();
                if (options.enableVersioning) {
                    deployTask.lambda.publishVersion({FunctionName: func_name, Description: getDeploymentDescription()}, function (err, data) {
                        if (err) {
                            grunt.fail.warn('Publishing version for function ' + func_name + ' failed with message ' + err.message);
                            deferred.reject();
                        } else {
                            version = data.Version;
                            grunt.log.writeln('Version ' + version + ' published.');
                            deferred.resolve();
                        }
                    });
                } else {
                    deferred.resolve();
                }

                return deferred.promise;
            };

            var createOrUpdateAlias = function (func_name, set_alias) {
                var deferred = Q.defer();

                var params = {
                    FunctionName: func_name,
                    Name: set_alias
                };


                deployTask.lambda.getAlias(params, function (err, data) {
                    params.FunctionVersion = version;
                    params.Description = getDeploymentDescription();
                    var aliasFunction = 'updateAlias';
                    if (err) {
                        if (err.statusCode === 404) {
                            aliasFunction = 'createAlias';
                        } else {
                            grunt.fail.warn('Listing aliases for ' + func_name + ' failed with message ' + err.message);
                            deferred.reject();
                            return;
                        }
                    }
                    deployTask.lambda[aliasFunction](params, function (err, data) {
                        if (err) {
                            grunt.fail.warn(aliasFunction + ' for ' + func_name + ' failed with message ' + err.message);
                            deferred.reject();
                        } else {
                            grunt.log.writeln('Alias ' + set_alias + ' updated pointing to version ' + version + '.');
                            deferred.resolve();
                        }
                    });
                });

                return deferred.promise;
            };

            var setAliases = function (func_name) {
                if (options.aliases) {
                    var promises = [];
                    options.aliases.forEach(function (alias) {
                        promises.push(createOrUpdateAlias(func_name, alias));
                    });
                    return Q.all(promises);
                }
            };

            var setPackageVersionAlias = function (func_name) {
                if (options.enablePackageVersionAlias && package_version) {
                    return createOrUpdateAlias(func_name, package_version.replace(/\./g, '-'));
                }
            };

            grunt.log.writeln('Uploading...');
            fs.readFile(deploy_package, function (err, data) {
                if (err) {
                    grunt.fail.warn('Could not read package file (' + deploy_package + '), verify the lambda package ' +
                        'location is correct, and that you have already created the package using lambda_package.');
                }

                var codeParams = {
                    FunctionName: deploy_function,
                    ZipFile: data
                };

                deployTask.lambda.updateFunctionCode(codeParams, function (err, data) {
                    if (err) {
                        grunt.fail.warn('Package upload failed, check you have lambda:UpdateFunctionCode permissions and that your package is not too big to upload.');
                    }

                    grunt.log.writeln('Package deployed.');

                    updateConfig(deploy_function, configParams)
                        .then(function () {return createVersion(deploy_function);})
                        .then(function () {return setAliases(deploy_function);})
                        .then(function () {return setPackageVersionAlias(deploy_function);})
                        .then(function () {
                            done(true);
                        }).catch(function (err) {
                        grunt.fail.warn('Uncaught exception: ' + err.message);
                    });
                });
            });
        });
    };
};

module.exports = deployTask;
