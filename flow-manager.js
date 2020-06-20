const path = require('path')
    , async = require('asyncawait/async')
    , await = require('asyncawait/await')
    , fs = require('fs-extra')
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
let RED;

// Restoring envnode override values after deploy, so UI cannot change them.
const originalSetFlows = PRIVATERED.runtime.flows.setFlows;
PRIVATERED.runtime.flows.setFlows = function newSetFlows(data) {

    const allFlows = {"global":[]}, // global contians global config-nodes
        mapFlowIdToNameAndType = {} // type is either "tab" or "subflow"

    const envNodePropsChangedByUser = {};

    for(const node of data.flows.flows) {
        //
        // Enforce envnodes consistency
        //
        if (directories.nodesEnvConfig[node.id]) {
            for (const key of Object.keys(directories.nodesEnvConfig[node.id])) {
                const val = directories.nodesEnvConfig[node.id][key];
                try {
                    if (JSON.stringify(node[key]) !== JSON.stringify(val)) {
                        if (!envNodePropsChangedByUser[node.id]) envNodePropsChangedByUser[node.id] = {};
                        envNodePropsChangedByUser[node.id][key] = val;
                        node[key] = val;
                    }
                } catch (e) {}
            }
        }
        //
        // Fill flows, subflows, config-nodes
        //
        if (node.type === 'tab' || node.type === 'subflow') {
            if (!allFlows[node.id]) allFlows[node.id] = [];
            allFlows[node.id].push(node);
            mapFlowIdToNameAndType[node.id] = {type:node.type, name: node.label || node.name};
        } else if (!node.z) {
            // global (config-node)
            allFlows.global.push(node);
        } else {
            // simple node
            if(!allFlows[node.z]) allFlows[node.z] = [];
            allFlows[node.z].push(node);
        }
    }

    // If envnode property changed, send back original values to revert on Node-RED UI as well.
    if(Object.keys(envNodePropsChangedByUser).length>0) {
        RED.comms.publish('flow-manager/flow-manager-envnodes-override-attempt', envNodePropsChangedByUser);
    }

    setTimeout(async(function saveFlowFiles() {

        for(const flowId of Object.keys(allFlows)) {

            // Cloning flow, we potentially save a different flow file than the one we deploy.
            // this is because for every property overriden by envnode, we store an empty string "" in the actual file
            // we do that because we don't want the flow files to change every the envnode properties change.
            const flowNodes = JSON.parse(JSON.stringify(allFlows[flowId]));
            const flowDetails = mapFlowIdToNameAndType[flowId];

            for(const node of flowNodes) {
                // Set properties used by envnodes to = "" empty string
                if(directories.savedEnvConfig.hasOwnProperty(node.id)) {
                    Object.assign(node, directories.savedEnvConfig[node.id]);
                }
                // delete credentials
                delete node.credentials;
            }

            let folderName;
            if(flowDetails) {
                if(flowDetails.type === 'subflow') folderName = 'subflows';
                // flow - tab
                else folderName = 'flows';
            } else {
                // global (config-nodes)
                folderName = '.';
            }

            const flowsDir = path.resolve(directories.basePath, folderName);
            const flowName = flowId === 'global' ? 'config-nodes' : flowDetails.name; // if it's a subflow, then the correct property is 'name'
            const flowFilePath = path.join(flowsDir, encodeFileName(flowName) + '.' + flowManagerSettings.fileFormat);

            try {
                // save flow file
                await(writeFlowFile(flowFilePath, flowNodes));
            } catch(err) {}
        }
    }),0);

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
    return fs.outputFile(filePath, str);
}

const readFlowFile = async(function (filePath) {

    const fileContentsStr = await(fs.readFile(filePath, 'utf-8'));

    const indexOfExtension = filePath.lastIndexOf('.');
    const fileExt = filePath.substring(indexOfExtension+1).toLowerCase();

    const finalObject = fileExt === 'yaml'? YAML.safeLoad(fileContentsStr) : JSON.parse(fileContentsStr);

    if(fileExt !== flowManagerSettings.fileFormat) {
        // File needs conversion
        const newFilePathWithNewExt = filePath.substring(0, indexOfExtension) + '.' + flowManagerSettings.fileFormat;
        await(writeFlowFile(newFilePathWithNewExt, finalObject));

        // Delete old file
        await(fs.remove(filePath));
    }

    return finalObject;
})

const readActiveProject = async(function() {
    try {
        const redConfig = await(fs.readJson(path.join(RED.settings.userDir, '.config.json')))
        return redConfig.projects.activeProject;
    } catch (e) {
        return null;
    }
});

const directories = {};
const main = async(function() {

    const refreshDirectories = async(function () {
        let basePath, project = null;
        if(RED.settings.editorTheme.projects.enabled) {
            project = await(readActiveProject());

            const activeProjectPath = path.join(RED.settings.userDir, 'projects', project);

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
            project: project
        });
        directories.flowVisibilityJsonFilePath = path.resolve(directories.basePath, 'flow_visibility.json')

        directories.defaultEnvNodeFilePath = path.resolve(directories.envNodesDir, 'default.jsonata');
        directories.currentEnvNodeFilePath = path.resolve(directories.envNodesDir, process.env.NODE_ENV + '.jsonata');

        directories.configNodesFilePathWithoutExtension = path.resolve(basePath, 'config-nodes');

        // Read flow-manager settings
        let needToSaveFlowManagerSettings = false;
        try {
            const fileJson = await(fs.readJson(directories.flowVisibilityJsonFilePath));

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
            await(fs.outputFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings)));
        }

        directories.configNodesFilePath = directories.configNodesFilePathWithoutExtension + '.' + flowManagerSettings.fileFormat;

        // Loading ENV configuration for nodes
        directories.nodesEnvConfig = {};
        for(const cfgPath of [directories.defaultEnvNodeFilePath, directories.currentEnvNodeFilePath]) {
            try {
                const fileContents = await(fs.readFile(cfgPath, 'UTF-8'));
                try {
                    const jsonataResult = jsonata(fileContents).evaluate({
                        require: require,
                        basePath: directories.basePath
                    });
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

        await(fs.ensureDir(directories.flowsDir));
        await(fs.ensureDir(directories.subflowsDir));
    });

    const loadFlows = async(function (flowsToShow = null) {

        const flowsDir = directories.flowsDir;

        let flowJsonSum = [];

        let items = await(fs.readdir(flowsDir)).filter(item => ()=>{
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

        const subflowItems = await(fs.readdir(subflowsDir)).filter(item=>{
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

    const checkIfMigrationIsRequried = async(function () {
        try {
            // Check if we need to migrate from "fat" flow json file to managed mode.
            if( await(fs.readdir(directories.flowsDir)).length===0 &&
                await(fs.readdir(directories.subflowsDir)).length===0
            ) {
                nodeLogger.info('First boot with flow-manager detected, starting migration process...');
                return true;
            }
        } catch(e) {}
        return false;
    });

    const startFlowManager = async(function () {
        await(refreshDirectories());

        if(await(checkIfMigrationIsRequried())) {
            const masterFlowFile = await(fs.readJson(directories.flowFile));

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

        // Delete flows json file (will be replaced with our flow manager logic (filters & combined separate flow json files)
        fs.remove(directories.flowFile).then(function () {
            nodeLogger.info('Deleted previous flows json file.');
            return Promise.resolve();
        }).catch(function () {return Promise.resolve();})

        const eraseMainFlowsAndLoadActualFlows = async(function eraseMainFlowsAndLoadActualFlows() {
            await(PRIVATERED.nodes.setFlows([], 'full'));
            await(loadFlows());
        });

        if(directories.project) {
            RED.events.once('runtime-event', async(function () {
                await(eraseMainFlowsAndLoadActualFlows());
            }));
        } else {
            await(eraseMainFlowsAndLoadActualFlows());
        }
    });

    await(startFlowManager());
    if(directories.project) {
        let lastProject = await(readActiveProject());
        fs.watch(path.join(RED.settings.userDir, '.config.json'), async(() => {
            const newProject = await(readActiveProject());
            if(lastProject != newProject) {
                lastProject = newProject;
                await(startFlowManager());
            }
        }));
    }

    RED.httpAdmin.get( '/'+nodeName+'/flows.json', async(function (req, res) {
        try {
            let flowFiles = await(fs.readdir(path.join(directories.basePath, "flows")));
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
            await(fs.outputFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings)));
            await(loadFlows(flowManagerSettings.filter));
            res.send({});
        } catch(e) {
            res.status(404).send();
        }
    }));

    // serve libs
    RED.httpAdmin.use( '/'+nodeName+'/flow_visibility.json', serveStatic(path.join(directories.basePath, "flow_visibility.json")) );
});

module.exports = function(_RED) {
    RED = _RED;
    main();
};
