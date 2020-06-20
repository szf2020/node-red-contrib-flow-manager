const path = require('path')
    , async = require('asyncawait/async')
    , await = require('asyncawait/await')
    , fsPromise = require('fs-promise')
    , bodyParser = require('body-parser')
    , log4js = require('log4js')
    , serveStatic = require('serve-static')
    , os = require("os")
    , jsonata = require('jsonata')
    , eol = require('eol')
    , YAML = require('js-yaml')
;

function encodeFileName(origName) {
    return origName.
    replace(/\\/g, '%5C').
    replace(/\//g, '%2F').
    replace(/\:/g, '%3A').
    replace(/\*/g, '%2A').
    replace(/\?/g, '%3F').
    replace(/\""/g, '%22').
    replace(/\</g, '%3C').
    replace(/\>/g, '%3E').
    replace(/\|/g, '%7C')

    // Characters not allowed: \ / : * ? " < > |
}

function stringifyFormattedFileJson(nodes) {
    const str = JSON.stringify(nodes, undefined, 2);
    return eol.auto(str);
}

// NOTE(alonam) a little trick to require the same "node-red" API to give private access to our own modulesContext.
const PRIVATERED = (function requireExistingNoderedInstance() {
    for(const child of require.main.children) {
        if(child.filename.endsWith('red.js')) {
            return require(child.filename);
        }
    }
    // In case node-red was not required before, just require it
    return require('node-red');
})();

const nodeName = path.basename(__filename).split('.')[0];
const nodeLogger = log4js.getLogger('NodeRed FlowManager');

// Restoring envnode override values after deploy, so UI cannot change them.
const originalSetFlows = PRIVATERED.runtime.flows.setFlows;
let RED;
PRIVATERED.runtime.flows.setFlows = function newSetFlows(data) {
    let count = 0;
    let envNodePropsChangedByUser = {};
    if(directories.nodesEnvConfig) {
        for(const node of data.flows.flows) {
            if(directories.nodesEnvConfig[node.id]) {
                count++;
                for(const key of Object.keys(directories.nodesEnvConfig[node.id])) {
                    const val = directories.nodesEnvConfig[node.id][key];
                    try {
                        if(JSON.stringify(node[key]) !== JSON.stringify(val)) {
                            if(!envNodePropsChangedByUser[node.id]) envNodePropsChangedByUser[node.id] = {};
                            envNodePropsChangedByUser[node.id][key] = val;
                            node[key] = val;
                        }
                    } catch (e) {}
                }
                if(count >= Object.keys(directories.nodesEnvConfig).length) {
                    break;
                }
            }
        }
    }
    if(Object.keys(envNodePropsChangedByUser).length>0) {
        RED.comms.publish('flow-manager/flow-manager-envnodes-override-attempt', envNodePropsChangedByUser);
    }
    return originalSetFlows.apply(PRIVATERED.runtime.flows, arguments);
}

const flowManagerSettings = {};

function writeFlowFile(filePath, flowObject) {
    let str;
    if(flowManagerSettings.fileFormat === 'yaml') {
        str = YAML.safeDump(flowObject);
    } else {
        str = stringifyFormattedFileJson(flowObject);
    }
    return fsPromise.writeFile(filePath, str);
}

const readFlowFile = async(function (filePath) {

    const fileContentsStr = await(fsPromise.readFile(filePath, 'utf-8'));

    const indexOfExtension = filePath.lastIndexOf('.');
    const fileExt = filePath.substring(indexOfExtension+1).toLowerCase();

    const finalObject = fileExt === 'yaml'? YAML.safeLoad(fileContentsStr) : JSON.parse(fileContentsStr);

    if(fileExt !== flowManagerSettings.fileFormat) {
        // File needs conversion
        const newFilePathWithNewExt = filePath.substring(0, indexOfExtension) + '.' + flowManagerSettings.fileFormat;
        await(writeFlowFile(newFilePathWithNewExt, finalObject));

        // Delete old file
        await(fsPromise.remove(filePath));
    }

    return finalObject;
})

const directories = {};
module.exports = async(function(_RED) {
    RED = _RED;
    let changedWorkspacesDeployed = new Set();

    const refreshDirectories = async(function () {
        let basePath;
        if(RED.settings.editorTheme.projects.enabled) {
            const redConfig = JSON.parse(
                await(fsPromise.readFile(path.join(RED.settings.userDir, '.config.json'), 'utf-8'))
            );
            const activeProject = redConfig.projects.activeProject;

            const activeProjectPath = path.join(RED.settings.userDir, 'projects', activeProject);

            basePath = activeProjectPath;
        } else {
            basePath = RED.settings.userDir;
        }

        Object.assign(directories, {
            basePath: basePath,
            subflowsDir: path.resolve(basePath, 'subflows'),
            flowsDir: path.resolve(basePath, 'flows'),
            envNodesDir: path.resolve(basePath, 'envnodes'),
            flowFile: path.resolve(basePath, RED.settings.flowFile || 'flows_'+os.hostname()+'.json'),
        });
        directories.flowVisibilityJsonFilePath = path.resolve(directories.basePath, 'flow_visibility.json')
        
        directories.defaultEnvNodeFilePath = path.resolve(directories.envNodesDir, 'default.jsonata');
        directories.currentEnvNodeFilePath = path.resolve(directories.envNodesDir, process.env.NODE_ENV + '.jsonata');

        directories.configNodesFilePathWithoutExtension = path.resolve(basePath, 'config-nodes');

        // Read flow-manager settings
        let needToSaveFlowManagerSettings = false;
        try {
            const fileStr = await(fsPromise.readFile(directories.flowVisibilityJsonFilePath, 'utf-8'));
            const fileJson = JSON.parse(fileStr);

            // Backwards compatibility
            if(Array.isArray(fileJson)) {
                needToSaveFlowManagerSettings = true;
                flowManagerSettings.filter = fileJson;
            } else if(typeof fileJson === 'object') {
                Object.assign(flowManagerSettings, fileJson);
            }
        } catch (e) {}
        finally {
            if(!Array.isArray(flowManagerSettings.filter)) {
                needToSaveFlowManagerSettings = true;
                flowManagerSettings.filter = [];
            }
            if(!flowManagerSettings.fileFormat) {
                needToSaveFlowManagerSettings = true;
                flowManagerSettings.fileFormat = 'json';
            }
        }
        if(needToSaveFlowManagerSettings) {
            await(fsPromise.writeFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings)));
        }

        directories.configNodesFilePath = directories.configNodesFilePathWithoutExtension + '.' + flowManagerSettings.fileFormat;

        // Loading ENV configuration for nodes
        directories.nodesEnvConfig = {};
        for(const cfgPath of [directories.defaultEnvNodeFilePath, directories.currentEnvNodeFilePath]) {
            try {
                const fileContents = await(fsPromise.readFile(cfgPath, 'UTF-8'));
                try {
                    const jsonataResult = jsonata(fileContents).evaluate({require:require});
                    Object.assign(directories.nodesEnvConfig, jsonataResult);
                } catch(e) {
                    nodeLogger.error('JSONata parsing failed for env nodes:\n', e);
                }
            } catch(e) {}
        }
        directories.savedEnvConfig = {};
        for(const nodeId of Object.keys(directories.nodesEnvConfig)) {
            const reducedArray = [{}].concat(Object.keys(directories.nodesEnvConfig[nodeId]));
            directories.savedEnvConfig[nodeId] = reducedArray.reduce((a,v)=>{
                a[v] = "";
                return a
            });
        }

        if(!await(fsPromise.exists(directories.flowsDir))) {
            await(fsPromise.mkdir(directories.flowsDir))
        }

        if(!await(fsPromise.exists(directories.subflowsDir))) {
            await(fsPromise.mkdir(directories.subflowsDir))
        }
    });
    await(refreshDirectories());

    RED.httpAdmin.post('/' + nodeName + '/deployed-changes', bodyParser.json(), function(req, res) {
        const workspacesChanged = req.body;
        if(workspacesChanged && workspacesChanged.length) {
            workspacesChanged.forEach(function(item) {
                changedWorkspacesDeployed.add(item);
            });
        }
        RED.comms.publish('flow-manager/deployed-changes', Array.from(changedWorkspacesDeployed));
        res.send(Array.from(changedWorkspacesDeployed));
    });

    RED.httpAdmin.get('/' + nodeName + '/deployed-changes', function(req, res) {
        res.send(Array.from(changedWorkspacesDeployed));
    });

    RED.httpAdmin.post('/' + nodeName + '/save/:id', bodyParser.json(), async(function(req, res) {

        const flowJson = req.body.flow;
        const configNodesJson = req.body.configNodes;

        const nodesSavedEnvConfig = directories.savedEnvConfig;

        for(const cfgNode of configNodesJson) {
            if(nodesSavedEnvConfig.hasOwnProperty(cfgNode.id)) {
                Object.assign(cfgNode, nodesSavedEnvConfig[cfgNode.id]);
            }
        }

        let flowNode;
        let flowNodeIndex=0;
        for(let i=0;i<flowJson.length;i++) {
            const node = flowJson[i];
            if(nodesSavedEnvConfig.hasOwnProperty(node.id)) {
                Object.assign(node, nodesSavedEnvConfig[node.id]);
            }

            if(node.id === req.params.id) {
                flowNode = node;
                flowNodeIndex = i;
            }
        }

        changedWorkspacesDeployed.delete(flowNode.id);
        RED.comms.publish('flow-manager/deployed-changes', Array.from(changedWorkspacesDeployed));

        const folderName = flowNode.type === 'tab'?'flows':'subflows';
        const flowsDir = path.resolve(directories.basePath, folderName);
        const flowName = flowNode.label || flowNode.name; // if it's a subflow, then the correct property is 'name'
        const flowFilePath = path.join(flowsDir, encodeFileName(flowName) + '.' + flowManagerSettings.fileFormat);

        // Fixing json, must have wires property, even if empty. otherwise node-red gets confused.
        const nodesJson = flowJson.slice(0,flowNodeIndex).concat(flowJson.slice(flowNodeIndex+1, flowJson.length)).map(item=>{
            // Add empty wires only if it's not a config node.
            if(!item.hasOwnProperty('wires') && req.body.allConfigNodeIds && req.body.allConfigNodeIds.indexOf(item.id) === -1) {
                item.wires = [];
            }
            return item;
        });
        const resultFlowJsonToSave = [flowNode].concat(nodesJson);

        try {
            // save flow file
            await(writeFlowFile(flowFilePath, resultFlowJsonToSave));

            // save config nodes file
            await(writeFlowFile(directories.configNodesFilePath, configNodesJson));
            res.send({success: true});
        } catch(err) {
            res.send({error: err})
        }
    }));
    
    const loadFlows = async(function (flowsToShow = null) {

        const flowsDir = directories.flowsDir;

        let flowJsonSum = [];

        let items = await(fsPromise.readdir(flowsDir)).filter(item => ()=>{
            const ext = path.extname(item).toLowerCase();
            return ext === '.json' || ext === '.yaml';
        });

        if(flowsToShow === null) {
            flowsToShow = flowManagerSettings.filter;
        }
        nodeLogger.info('Flow visibility file state:', flowsToShow);

        // Hide flows only if array is not empty
        if(flowsToShow && flowsToShow.length) {
            items = items.filter(item=>{
                const itemWithoutExt = item.substring(0, item.lastIndexOf('.'));
                return flowsToShow.indexOf(itemWithoutExt) !== -1;
            });
        }

        // read flows
        for(const algoFlowFileName of items) {
            try {
                const flowJsonFileContents = await(readFlowFile(path.join(flowsDir, algoFlowFileName)));
                flowJsonSum = flowJsonSum.concat(flowJsonFileContents);
            } catch (e) {
                nodeLogger.error('Could not load flow ' + algoFlowFileName + '\r\n' + e.stack||e);
            }
        }

        // read subflows
        const subflowsDir = directories.subflowsDir;

        const subflowItems = await(fsPromise.readdir(subflowsDir)).filter(item=>{
            const itemLC = item.toLowerCase();
            return itemLC.endsWith('.yaml') || itemLC.endsWith('.json');
        });
        for(const subflowFileName of subflowItems) {
            try {
                const flowJsonFileContents = await(readFlowFile(path.join(subflowsDir, subflowFileName)));

                flowJsonSum = flowJsonSum.concat(flowJsonFileContents);
            } catch (e) {
                nodeLogger.error('Could not load subflow ' + subflowFileName + '\r\n' + e.stack||e);
            }
        }

        // read config nodes
        try {
            let configNodes;
            try {
                configNodes = await(readFlowFile(directories.configNodesFilePathWithoutExtension+'.json'));
            } catch (e) {
                configNodes = await(readFlowFile(directories.configNodesFilePathWithoutExtension+'.yaml'));
            }
            flowJsonSum = flowJsonSum.concat(configNodes);
        } catch(e) {}

        const nodesEnvConfig = directories.nodesEnvConfig;

        // If we have node config modifications for this ENV, iterate and apply node updates from ENV config.
        if(nodesEnvConfig && Object.keys(nodesEnvConfig).length) {
            for(const node of flowJsonSum) {
                // If no patch exists for this id
                if(!node || !node.id || !nodesEnvConfig.hasOwnProperty(node.id)) continue;

                Object.assign(node, nodesEnvConfig[node.id]);
            }
        }

        nodeLogger.info('Loading flows:', items);
        nodeLogger.info('Loading subflows:', subflowItems);

        try {
            await(PRIVATERED.nodes.setFlows(flowJsonSum, 'full'));
            nodeLogger.info('Finished setting node-red nodes successfully.');
        } catch (e) {
            nodeLogger.error('Failed setting node-red nodes\r\n' + e.stack||e);
        }
    });


    RED.httpAdmin.get( '/'+nodeName+'/flows.json', async(function (req, res) {
        try {
            let flowFiles = await(fsPromise.readdir(path.join(directories.basePath, "flows")));
            flowFiles = flowFiles.filter(file=>file.toLowerCase().match(/.*\.(json)|(yaml)$/g));
            res.send(flowFiles);
        } catch(e) {
            res.status(404).send();
        }
    }));

    RED.httpAdmin.patch( '/'+nodeName+'/flow_visibility.json', bodyParser.json(), async(function (req, res) {
        const patchObj = req.body;
        try {
            Object.assign(flowManagerSettings, patchObj);
            await(fsPromise.writeFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings)));
            await(loadFlows(flowManagerSettings.filter));
            res.send({});
        } catch(e) {
            res.status(404).send();
        }
    }));

    // serve libs
    RED.httpAdmin.use( '/'+nodeName+'/favicon.ico', serveStatic(path.join(__dirname, "static", "favicon.ico")) );
    RED.httpAdmin.use( '/'+nodeName+'/node_modules', serveStatic(path.join(__dirname, "node_modules")) );
    RED.httpAdmin.use( '/'+nodeName+'/flow_visibility.json', serveStatic(path.join(directories.basePath, "flow_visibility.json")) );

    const checkIfMigrationIsRequried = async(function () {
        try {
            const masterFlowFilePath = directories.flowFile;

            // Check if we need to migrate from "fat" flow json file to managed mode.
            if( await(fsPromise.readdir(directories.flowsDir)).length===0 &&
                await(fsPromise.readdir(directories.subflowsDir)).length===0
            ) {
                nodeLogger.info('First boot with flow-manager detected, starting migration process...');
                return await(fsPromise.readFile(masterFlowFilePath, 'utf-8'));
            }
        } catch(e) {}
        return null;
    });

    const masterFlowFileContentsToMigrate = await(checkIfMigrationIsRequried());
    if(masterFlowFileContentsToMigrate) {
        const masterFlowFile = JSON.parse(masterFlowFileContentsToMigrate);

        const flowNodes = {};
        const globalConfigNodes = [], simpleNodes = [];

        for (const node of masterFlowFile) {
            if(node.type === 'tab' || node.type === 'subflow') flowNodes[node.id] = [node];
            else if(!node.z || node.z.length === 0) globalConfigNodes.push(node);
            else simpleNodes.push(node);
        }

        for(const node of simpleNodes) {
            if(flowNodes[node.z]) flowNodes[node.z].push(node);
        }

        // finally write files
        const fileWritePromises = [writeFlowFile(directories.configNodesFilePath, globalConfigNodes)];
        for(const flowId of Object.keys(flowNodes)) {
            const nodesInFlow = flowNodes[flowId];
            const topNode = nodesInFlow[0];
            const flowName = topNode.label || topNode.name; // label on tabs ,

            const destinationFile = path.resolve(directories.basePath, topNode.type === 'tab'? 'flows':'subflows', encodeFileName(flowName)+'.'+flowManagerSettings.fileFormat);

            fileWritePromises.push(
                writeFlowFile(destinationFile, nodesInFlow)
            );
        }
        await(Promise.all(fileWritePromises));
        nodeLogger.info('flow-manager migration complete.');
    }

    Promise.all([
        await(PRIVATERED.nodes.setFlows([], 'full')),

        // Delete flows json file (will be replaced with our flow manager logic (filters & combined separate flow json files)
        fsPromise.unlink(directories.flowFile).then(function () {
            nodeLogger.info('Deleted previous flows json file.');
            return Promise.resolve();
        }).catch(function () {return Promise.resolve();})
    ]);

    await(loadFlows());
});
