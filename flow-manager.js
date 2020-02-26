const path = require('path')
    , fsPromise = require('fs-promise')
    , bodyParser = require('body-parser')
    , log4js = require('log4js')
    , serveStatic = require('serve-static')
    , os = require("os")
    , jsonata = require('jsonata')
    , eol = require('eol')
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

function stringifyNodesFileJson(nodes) {
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

module.exports = async function(RED) {
    const directories = {};

    let changedWorkspacesDeployed = new Set();

    async function refreshDirectories() {
        let basePath;
        if(RED.settings.editorTheme.projects.enabled) {
            const redConfig = JSON.parse(
                await fsPromise.readFile(path.join(RED.settings.userDir, '.config.json'), 'utf-8')
            );
            const activeProject = redConfig.projects.activeProject;

            const activeProjectPath = path.join(RED.settings.userDir, 'projects', activeProject);

            basePath = activeProjectPath;
        } else {
            basePath = RED.settings.userDir;
        }

        Object.assign(directories, {
            basePath: basePath,
            configNodesFilePath: path.resolve(basePath, 'config-nodes.json'),
            subflowsDir: path.resolve(basePath, 'subflows'),
            flowsDir: path.resolve(basePath, 'flows'),
            envNodesDir: path.resolve(basePath, 'envnodes'),
            flowFile: path.resolve(basePath, RED.settings.flowFile || 'flows_'+os.hostname()+'.json')
        });
        directories.defaultEnvNodeFilePath = path.resolve(directories.envNodesDir, 'default.jsonata');
        directories.currentEnvNodeFilePath = path.resolve(directories.envNodesDir, process.env.NODE_ENV + '.jsonata');

        // Loading ENV configuration for nodes
        directories.nodesEnvConfig = {};
        for(const cfgPath of [directories.defaultEnvNodeFilePath, directories.currentEnvNodeFilePath]) {
            try {
                const fileContents = await fsPromise.readFile(cfgPath, 'UTF-8');
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

        if(!(await fsPromise.exists(directories.flowsDir))) {
            (await fsPromise.mkdir(directories.flowsDir))
        }

        if(!(await fsPromise.exists(directories.subflowsDir))) {
            (await fsPromise.mkdir(directories.subflowsDir))
        }
    }
    await refreshDirectories();

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

    RED.httpAdmin.post('/' + nodeName + '/save/:id', bodyParser.json(), async function(req, res) {

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
        const flowFilePath = path.join(flowsDir, encodeFileName(flowName) + '.json');

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
            await fsPromise.writeFile(flowFilePath, stringifyNodesFileJson(resultFlowJsonToSave, undefined, 2));

            // save config nodes file
            await fsPromise.writeFile(directories.configNodesFilePath, stringifyNodesFileJson(configNodesJson, undefined, 2));
            res.send({success: true});
        } catch(err) {
            res.send({error: err})
        }
    });

    // write flows
    const flowVisibilityJsonFilePath = path.resolve(directories.basePath, 'flow_visibility.json');
    async function loadFlows(flowsToShow = null) {

        const flowsDir = directories.flowsDir;

        let flowJsonSum = [];
        let items = (await fsPromise.readdir(flowsDir)).filter(item => item.toLowerCase().endsWith('.json'));
        if(flowsToShow === null) {
            try {
                flowsToShow = JSON.parse(
                    await fsPromise.readFile(flowVisibilityJsonFilePath, 'utf-8')
                )
            } catch(e) {}
        }
        nodeLogger.info('Flow visibility file state:', flowsToShow);

        // Hide flows only if array is not empty
        if(flowsToShow && flowsToShow.length) {
            const jsonFilesToBeVisible = flowsToShow.map(flow=>flow+'.json');
            items = items.filter(item=>jsonFilesToBeVisible.indexOf(item) !== -1);
        }

        for(const algoFlowFileName of items) {
            try {
                const flowJsonFileContents = JSON.parse(
                    await fsPromise.readFile(path.join(flowsDir, algoFlowFileName), 'utf-8')
                );
                flowJsonSum = flowJsonSum.concat(flowJsonFileContents);
            } catch (e) {
                nodeLogger.error('Could not load flow ' + algoFlowFileName + '\r\n' + e.stack||e);
            }
        }

        // write subflows
        const subflowsDir = directories.subflowsDir;

        const subflowItems = (await fsPromise.readdir(subflowsDir)).filter(item=>item.toLowerCase().endsWith('.json'));
        for(const subflowFileName of subflowItems) {
            try {
                const flowJsonFileContents = JSON.parse(
                    await fsPromise.readFile(path.join(subflowsDir, subflowFileName), 'utf-8')
                );
                flowJsonSum = flowJsonSum.concat(flowJsonFileContents);
            } catch (e) {
                nodeLogger.error('Could not load subflow ' + subflowFileName + '\r\n' + e.stack||e);
            }
        }

        // write config nodes
        const configNodesPath = path.resolve(directories.basePath, 'config-nodes.json');
        try {
            const configNodes = JSON.parse(
                await fsPromise.readFile(configNodesPath)
            );
            flowJsonSum = flowJsonSum.concat(configNodes);
        } catch(e) {
            nodeLogger.error('Could not load global config-nodes file ' + configNodesPath + '\r\n' + e.stack||e);
        }


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
            await PRIVATERED.nodes.setFlows(flowJsonSum, 'full');
            nodeLogger.info('Finished setting node-red nodes successfully.');
        } catch (e) {
            nodeLogger.error('Failed setting node-red nodes\r\n' + e.stack||e);
        }
    }


    RED.httpAdmin.get( '/'+nodeName+'/flows.json', async function (req, res) {
        try {
            let flowFiles = await fsPromise.readdir(path.join(directories.basePath, "flows"));
            flowFiles = flowFiles.filter(file=>file.toLowerCase().endsWith('.json'));
            res.send(flowFiles);
        } catch(e) {
            res.status(404).send();
        }
    });

    RED.httpAdmin.put( '/'+nodeName+'/flow_visibility.json', bodyParser.json(), async function (req, res) {
        const flowsToShow = req.body;
        try {
            await fsPromise.writeFile(flowVisibilityJsonFilePath, stringifyNodesFileJson(flowsToShow, null, 2));
            await loadFlows(flowsToShow);
            res.send({});
        } catch(e) {
            res.status(404).send();
        }
    });

    // serve libs
    RED.httpAdmin.use( '/'+nodeName+'/favicon.ico', serveStatic(path.join(__dirname, "static", "favicon.ico")) );
    RED.httpAdmin.use( '/'+nodeName+'/node_modules', serveStatic(path.join(__dirname, "node_modules")) );
    RED.httpAdmin.use( '/'+nodeName+'/flow_visibility.json', serveStatic(path.join(directories.basePath, "flow_visibility.json")) );

    async function checkIfMigrationIsRequried() {
        try {
            const masterFlowFilePath = directories.flowFile;

            // Check if we need to migrate from "fat" flow json file to managed mode.
            if( (await fsPromise.readdir(directories.flowsDir)).length===0 &&
                (await fsPromise.readdir(directories.subflowsDir)).length===0
            ) {
                nodeLogger.info('First boot with flow-manager detected, starting migration process...');
                return await fsPromise.readFile(masterFlowFilePath, 'utf-8');
            }
        } catch(e) {}
        return null;
    }

    const masterFlowFileContentsToMigrate = await checkIfMigrationIsRequried();
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
        const fileWritePromises = [fsPromise.writeFile(directories.configNodesFilePath, stringifyNodesFileJson(globalConfigNodes, undefined, 2))];
        for(const flowId of Object.keys(flowNodes)) {
            const nodesInFlow = flowNodes[flowId];
            const topNode = nodesInFlow[0];
            const flowName = topNode.label || topNode.name; // label on tabs ,

            const destinationFile = path.resolve(directories.basePath, topNode.type === 'tab'? 'flows':'subflows', encodeFileName(flowName)+'.json');

            fileWritePromises.push(
                fsPromise.writeFile(destinationFile, stringifyNodesFileJson(nodesInFlow, undefined, 2))
            );
        }
        await Promise.all(fileWritePromises);
        nodeLogger.info('flow-manager migration complete.');
    }

    Promise.all([
        await PRIVATERED.nodes.setFlows([], 'full'),

        // Delete flows json file (will be replaced with our flow manager logic (filters & combined separate flow json files)
        fsPromise.unlink(directories.flowFile).then(function () {
            nodeLogger.info('Deleted previous flows json file.');
            return Promise.resolve();
        }).catch(function () {return Promise.resolve();})
    ]);

    await loadFlows();
};
