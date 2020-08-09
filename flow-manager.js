const path = require('path')
    , fs = require('fs-extra')
    , bodyParser = require('body-parser')
    , log4js = require('log4js')
    , serveStatic = require('serve-static')
    , os = require("os")
    , jsonata = require('jsonata')
    , eol = require('eol')
    , YAML = require('js-yaml')
    , child_process = require('child_process')
    , crypto = require('crypto')
    , debounce = require('./debounce')
;

function execShellCommand(cmd) {
    return new Promise((resolve, reject) => {
        child_process.exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr||stdout));
            }
            resolve(stdout);
        });
    });
}

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

const originalSaveFlows = PRIVATERED.runtime.storage.saveFlows;
let lastFlows = {};

PRIVATERED.runtime.storage.saveFlows = async function newSaveFlows(data) {
    if(data.flows && data.flows.length) {

        function getFlowFilePath(flowDetails) {
            let folderName;
            if(flowDetails.type === 'subflow') folderName = 'subflows';
            else if(flowDetails.type === 'tab') folderName = 'flows';
            else folderName = '.';

            const flowsDir = path.resolve(directories.basePath, folderName);
            const flowName = flowDetails.type === 'global' ? 'config-nodes' : flowDetails.name; // if it's a subflow, then the correct property is 'name'
            const flowFilePath = path.join(flowsDir, encodeFileName(flowName) + '.' + flowManagerSettings.fileFormat);
            return flowFilePath;
        }

        const allFlows = {};
        const loadedFlowAndSubflowNames = {};

        const envNodePropsChangedByUser = {};

        for(const node of data.flows) {
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
                if (!allFlows[node.id]) allFlows[node.id] = {nodes: []};
                if (!allFlows[node.id].name) allFlows[node.id].name = node.label || node.name;
                if (!allFlows[node.id].type) allFlows[node.id].type = node.type;

                loadedFlowAndSubflowNames[node.id] = allFlows[node.id];

                allFlows[node.id].nodes.push(node);
            } else if (!node.z) {
                // global (config-node)
                if(!allFlows.global) allFlows.global = {name:"config-nodes", type:"global", nodes: []};
                allFlows.global.nodes.push(node);
            } else {
                // simple node
                if(!allFlows[node.z]) allFlows[node.z] = {nodes: []};
                allFlows[node.z].nodes.push(node);
            }
        }

        // If envnode property changed, send back original values to revert on Node-RED UI as well.
        if(Object.keys(envNodePropsChangedByUser).length>0) {
            RED.comms.publish('flow-manager/flow-manager-envnodes-override-attempt', envNodePropsChangedByUser);
        }

        for(const flowId of Object.keys(allFlows)) {

            // Cloning flow, we potentially save a different flow file than the one we deploy.
            // this is because for every property overriden by envnode, we store an empty string "" in the actual file
            // we do that because we don't want the flow files to change every the envnode properties change.

            const flowDetails = JSON.parse(JSON.stringify(allFlows[flowId]));
            const flowNodes = flowDetails.nodes;

            for(const node of flowNodes) {
                // Set properties used by envnodes to = "" empty string
                const foundNodeEnvConfig =
                    (node.name && directories.savedEnvConfig["name:"+node.name]) ||
                    (node.id && directories.savedEnvConfig[node.id]);

                if(foundNodeEnvConfig) {
                    Object.assign(node, foundNodeEnvConfig);
                }
                // delete credentials
                delete node.credentials;
            }

            const flowFilePath = getFlowFilePath(flowDetails);

            try {
                if(lastFlows[flowId] && allFlows[flowId] && lastFlows[flowId].name != allFlows[flowId].name) {
                    const flowsDir = path.dirname(flowFilePath);
                    const from = path.resolve(flowsDir, `${encodeFileName(lastFlows[flowId].name)}.${flowManagerSettings.fileFormat}`);
                    const to = path.resolve(flowFilePath);
                    try {
                        // First, try rename with git
                        await execShellCommand(`git mv -f "${from}" "${to}"`);
                    } catch (e) {
                        // if not working with git, do a normal "mv" command
                        try {
                            await fs.move(from, to, {overwrite: true});
                        } catch (e) {}
                    }
                }

                // save flow file
                await writeFlowFile(flowFilePath, flowNodes);
            } catch(err) {}
        }

        // Check which flows were removed, if any
        for(const flowId in lastFlows) {
            const flowName = lastFlows[flowId].name;
            if(!allFlows[flowId] && (
                (flowManagerSettings.filter.indexOf(flowName) !== -1 || flowManagerSettings.filter.length===0) ||
                lastFlows[flowId].type === 'subflow'
            )) {
                const flowFilePath = getFlowFilePath(lastFlows[flowId]);
                await fs.remove(flowFilePath);
            }
        }

        lastFlows = loadedFlowAndSubflowNames;
    }

    return originalSaveFlows.apply(PRIVATERED.runtime.storage, arguments);
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

async function readFlowFile(filePath, ignoreObj) {

    const retVal = {};

    const fileContentsStr = await fs.readFile(filePath, 'utf-8');
    retVal.str = fileContentsStr;

    if(ignoreObj) return retVal;

    const indexOfExtension = filePath.lastIndexOf('.');
    const fileExt = filePath.substring(indexOfExtension+1).toLowerCase();

    const finalObject = fileExt === 'yaml'? YAML.safeLoad(fileContentsStr) : JSON.parse(fileContentsStr);

    if(fileExt !== flowManagerSettings.fileFormat) {
        // File needs conversion
        const newFilePathWithNewExt = filePath.substring(0, indexOfExtension) + '.' + flowManagerSettings.fileFormat;
        await writeFlowFile(newFilePathWithNewExt, finalObject);

        // Delete old file
        await fs.remove(filePath);
    }
    retVal.obj = finalObject;

    return retVal;
}

async function readConfigFlowFile(ignoreObj) {
    try {
        return await readFlowFile(directories.configNodesFilePathWithoutExtension+'.json', ignoreObj);
    } catch (e) {
        return await readFlowFile(directories.configNodesFilePathWithoutExtension+'.yaml', ignoreObj);
    }
}

async function readFlowByNameAndType(type, name, ignoreObj) {
    const fileNameWithExt = `${name}.${flowManagerSettings.fileFormat}`;
    if(type === 'flow') {
        return await readFlowFile(path.join(directories.flowsDir, fileNameWithExt), ignoreObj);
    } else if(type === 'subflow') {
        return await readFlowFile(path.join(directories.subflowsDir, fileNameWithExt), ignoreObj);
    } else if(type === 'global') {
        return await(readConfigFlowFile(ignoreObj));
    }
}

async function flowFileExists(flowName) {
    return fs.exists(path.resolve(directories.flowsDir, `${flowName}.${flowManagerSettings.fileFormat}`));
}

async function readActiveProject() {
    try {
        const redConfig = await fs.readJson(path.join(RED.settings.userDir, '.config.json'));
        return redConfig.projects.activeProject;
    } catch (e) {
        return null;
    }
}

const revisions = {
    byFlowName: {},
    bySubflowName: {},
    global: null // config nodes, etc..
}

const directories = {};
async function main() {

    let initialLoadPromise = (()=>{
        let res;
        const p = new Promise((resolve, reject)=>{
            res = resolve;
        });
        p.resolve = res;
        return p
    })()

    const onDemandFlowsManager = {
        onDemandFlowsSet: new Set(),
        updateOnDemandFlowsSet: async function (newSet) {
            let totalSet;
            //
            // If flow file does not exist, or is already passed filtering settings, we don't consider it an on-demand flow
            //
            if(flowManagerSettings.filter.length === 0) {
                totalSet = new Set();
            } else {
                totalSet = new Set(Array.from(onDemandFlowsManager.onDemandFlowsSet).concat(Array.from(newSet)));
                for(const flowName of Array.from(totalSet)) {
                    if(!await flowFileExists(flowName) || flowManagerSettings.filter.indexOf(flowName) !== -1) {
                        totalSet.delete(flowName);
                    }
                }
            }

            onDemandFlowsManager.onDemandFlowsSet = totalSet;
            return onDemandFlowsManager.onDemandFlowsSet;
        }
    }

    function calculateRevision(str) {
        return crypto.createHash('md5').update(str).digest("hex");
    }

    const originalGetFlows = PRIVATERED.runtime.storage.getFlows;
    PRIVATERED.runtime.storage.getFlows = async function () {
        if(initialLoadPromise) await initialLoadPromise;
        const retVal = await originalGetFlows.apply(PRIVATERED.runtime.storage, arguments);

        const flowsInfo = await loadFlows(null, true);

        retVal.flows = flowsInfo.flows;
        retVal.rev = calculateRevision(JSON.stringify(flowsInfo.flows));
        revisions.byFlowName = flowsInfo.flowHashes;
        revisions.bySubflowName = flowsInfo.subflowHashes;

        lastFlows = flowsInfo.loadedFlowAndSubflowNames;

        return retVal;
    }

    async function refreshDirectories() {
        let basePath, project = null;
        if(RED.settings.editorTheme.projects.enabled) {
            project = await readActiveProject();

            if(project) {
                const activeProjectPath = path.join(RED.settings.userDir, 'projects', project);
                basePath = activeProjectPath;
            } else {
                basePath = RED.settings.userDir;
            }

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
            const fileJson = await fs.readJson(directories.flowVisibilityJsonFilePath);

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
            await fs.outputFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings));
        }

        directories.configNodesFilePath = directories.configNodesFilePathWithoutExtension + '.' + flowManagerSettings.fileFormat;

        // Loading ENV configuration for nodes
        directories.nodesEnvConfig = {};
        for(const cfgPath of [directories.defaultEnvNodeFilePath, directories.currentEnvNodeFilePath]) {
            try {
                const fileContents = await fs.readFile(cfgPath, 'UTF-8');
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
        for(const nodeSelector of Object.keys(directories.nodesEnvConfig)) {
            const reducedArray = [{}].concat(Object.keys(directories.nodesEnvConfig[nodeSelector]));
            directories.savedEnvConfig[nodeSelector] = reducedArray.reduce((a,v)=>{
                a[v] = "";
                return a
            });
        }

        await fs.ensureDir(directories.flowsDir);
        await fs.ensureDir(directories.subflowsDir);
    }

    async function readAllFlowFileNames(type='subflow') {
        const filesUnderFolder = (await fs.readdir(type==='subflow'?directories.subflowsDir:directories.flowsDir));
        const relevantItems = filesUnderFolder.filter(item => {
            const ext = path.extname(item).toLowerCase();
            return ext === '.json' || ext === '.yaml';
        });
        return relevantItems;
    }

    async function readAllFlowFileNamesWithoutExt(type) {
        return (await readAllFlowFileNames(type)).map(
            file=>file.substring(0, file.lastIndexOf('.'))
        );
    }

    async function loadFlows(flowsToShow = null, getMode = false) {
        const retVal = {
            flows: [],
            rev: null,
            flowHashes: {},
            subflowHashes: {},
            loadedFlowAndSubflowNames: {}
        }

        let flowJsonSum = {
            tabs: [],
            subflows: [],
            global: [],
            nodes: []
        };

        let items = await readAllFlowFileNames('flow');

        if(flowsToShow === null) {
            flowsToShow = flowManagerSettings.filter;
        }
        nodeLogger.info('Flow visibility file state:', flowsToShow);

        // read flows
        for(const algoFlowFileName of items) {
            try {
                const itemWithoutExt = algoFlowFileName.substring(0, algoFlowFileName.lastIndexOf('.'));
                if(!algoFlowFileName.toLowerCase().match(/.*\.(json)|(yaml)$/g)) continue;
                const flowJsonFile = await readFlowFile(path.join(directories.flowsDir, algoFlowFileName));
                retVal.flowHashes[itemWithoutExt] = calculateRevision(flowJsonFile.str);

                // Ignore irrelevant flows (filter flows functionality)
                if(flowsToShow && flowsToShow.length && flowsToShow.indexOf(itemWithoutExt) === -1) {
                    continue;
                }

                // find tab node
                let tab = null;
                for(let i=0; i<flowJsonFile.obj.length; i++) {
                    const node = flowJsonFile.obj[i];
                    if(node.type === 'tab') {
                        flowJsonSum.tabs.push(node);
                        flowJsonFile.obj.splice(i, 1);
                        tab = node;
                        break;
                    }
                }

                if(!tab) {throw new Error("Could not find tab node in flow file")}

                Array.prototype.push.apply(flowJsonSum.nodes, flowJsonFile.obj);
                retVal.loadedFlowAndSubflowNames[tab.id] = {type: tab.type, name: tab.label};
            } catch (e) {
                nodeLogger.error('Could not load flow ' + algoFlowFileName + '\r\n' + e.stack||e);
            }
        }

        // read subflows
        const subflowItems = (await fs.readdir(directories.subflowsDir)).filter(item=>{
            const itemLC = item.toLowerCase();
            return itemLC.endsWith('.yaml') || itemLC.endsWith('.json');
        });
        for(const subflowFileName of subflowItems) {
            try {
                const flowJsonFile = await readFlowFile(path.join(directories.subflowsDir, subflowFileName));

                // find subflow node
                let subflowNode = false;
                for(let i=0; i<flowJsonFile.obj.length; i++) {
                    const node = flowJsonFile.obj[i];
                    if(node.type === 'subflow') {
                        flowJsonSum.subflows.push(node);
                        flowJsonFile.obj.splice(i, 1);
                        subflowNode = node;
                        break;
                    }
                }
                if(!subflowNode) {throw new Error("Could not find subflow node in flow file")}

                Array.prototype.push.apply(flowJsonSum.nodes, flowJsonFile.obj);

                const itemWithoutExt = subflowFileName.substring(0, subflowFileName.lastIndexOf('.'));
                retVal.subflowHashes[itemWithoutExt] = calculateRevision(flowJsonFile.str);
                retVal.loadedFlowAndSubflowNames[subflowNode.id] = {type: subflowNode.type, name: subflowNode.name};

            } catch (e) {
                nodeLogger.error('Could not load subflow ' + subflowFileName + '\r\n' + e.stack||e);
            }
        }

        // read config nodes
        try {
            const configFlowFile = await readConfigFlowFile();
            revisions.global = calculateRevision(configFlowFile.str);
            Array.prototype.push.apply(flowJsonSum.global, configFlowFile.obj);
        } catch(e) {
            revisions.global = null;
        }

        retVal.flows = [...flowJsonSum.tabs, ...flowJsonSum.subflows, ...flowJsonSum.global, ...flowJsonSum.nodes];

        const nodesEnvConfig = directories.nodesEnvConfig;

        // If we have node config modifications for this ENV, iterate and apply node updates from ENV config.
        if(nodesEnvConfig && Object.keys(nodesEnvConfig).length) {
            for(const node of retVal.flows) {
                // If no patch exists for this id
                if(!node) continue;

                const foundNodeEnvConfig =
                    (node.name && nodesEnvConfig["name:"+node.name]) ||
                    (node.id && nodesEnvConfig[node.id]);

                if(foundNodeEnvConfig) {
                    Object.assign(node, foundNodeEnvConfig);
                }
            }
        }

        if(!getMode) {
            nodeLogger.info('Loading flows:', items);
            nodeLogger.info('Loading subflows:', subflowItems);
            try {
                retVal.rev = await PRIVATERED.nodes.setFlows(retVal.flows, null, 'flows');
                nodeLogger.info('Finished setting node-red nodes successfully.');
            } catch (e) {
                nodeLogger.error('Failed setting node-red nodes\r\n' + e.stack||e);
            }
        }

        return retVal;
    }

    async function checkIfMigrationIsRequried() {
        try {
            // Check if we need to migrate from "fat" flow json file to managed mode.
            if( (await fs.readdir(directories.flowsDir)).length===0 &&
                (await fs.readdir(directories.subflowsDir)).length===0 &&
                await fs.exists(directories.flowFile)
            ) {
                nodeLogger.info('First boot with flow-manager detected, starting migration process...');
                return true;
            }
        } catch(e) {}
        return false;
    }

    async function startFlowManager() {
        await refreshDirectories();

        if(await checkIfMigrationIsRequried()) {
            const masterFlowFile = await fs.readJson(directories.flowFile);

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
            await Promise.all(fileWritePromises);
            nodeLogger.info('flow-manager migration complete.');
        }

        // Delete flows json file (will be replaced with our flow manager logic (filters & combined separate flow json files)
        // fs.remove(directories.flowFile).then(function () {
        //     nodeLogger.info('Deleted previous flows json file.');
        //     return Promise.resolve();
        // }).catch(function () {return Promise.resolve();})
    }

    await startFlowManager();
    if(RED.settings.editorTheme.projects.enabled) {
        let lastProject = await readActiveProject();
        fs.watch(path.join(RED.settings.userDir, '.config.json'), debounce(async () => {
            const newProject = await readActiveProject();
            if(lastProject != newProject) {
                lastProject = newProject;
                await startFlowManager();
            }
        }, 500));
    }

    RED.httpAdmin.get( '/'+nodeName+'/flow-names', async function (req, res) {
        try {
            let flowFiles = await fs.readdir(path.join(directories.basePath, "flows"));
            flowFiles = flowFiles.filter(file=>file.toLowerCase().match(/.*\.(json)|(yaml)$/g));
            res.send(flowFiles);
        } catch(e) {
            res.status(404).send();
        }
    });

    async function getFlowState(type, flowName) {
        const wasLoadedOnDemand = type === 'flow' && onDemandFlowsManager.onDemandFlowsSet.has(flowName)

        let flowFileStr;
        try {
            flowFileStr = (await readFlowByNameAndType(type, flowName, true)).str;
        } catch (e) {
            return null;
        }

        const retVal = {};

        let lastLoadedFlowRevision;
        if(type==='flow') {
            lastLoadedFlowRevision = revisions.byFlowName[flowName];
            // If flow was not deployed either "on-demend" or passed filtering, we determine that it was not deployed.
            retVal.deployed = wasLoadedOnDemand || !flowManagerSettings.filter.length || flowManagerSettings.filter.indexOf(flowName) !== -1
        } else if(type==='subflow') {
            lastLoadedFlowRevision = revisions.bySubflowName[flowName];
            retVal.deployed = true;
        } else if(type==='global') {
            lastLoadedFlowRevision = revisions.global;
            retVal.deployed = true;
        } else {
            return null;
        }

        const fileRev = calculateRevision(flowFileStr);
        retVal.hasUpdate = fileRev !== lastLoadedFlowRevision;

        retVal.onDemand = wasLoadedOnDemand;

        return retVal;
    }

    async function getFlowStateForType(type) {
        if(type === 'flow' || type === 'subflow') {
            const retVal = {};
            const flowNames = await readAllFlowFileNamesWithoutExt(type);
            for(const flowName of flowNames) {
                retVal[flowName] = await getFlowState(type, flowName);
            }
            return retVal;
        } else if(type === 'global') {
            return await getFlowState(type);
        }
    }

    RED.httpAdmin.get( '/'+nodeName+'/flows/:type/:flowName', async function (req, res) {
        try {
            if(['subflow', 'flow', 'global'].indexOf(req.params.type) !== -1) {
                const state = await getFlowState(req.params.type, req.params.flowName);
                if(state) {
                    return res.send(state);
                } else {
                    return res.status(404).send({error: `No such ${req.params.type} file`});
                }
            } else {
                return res.status(404).send({error: `Unrecognised flow type: ${req.params.type}`});
            }
        } catch (e) {
            return res.status(404).send();
        }
    });

    RED.httpAdmin.get( '/'+nodeName+'/flows/:type', async function (req, res) {
        try {
            if(['subflow', 'flow', 'global'].indexOf(req.params.type) !== -1) {
                const retVal = await getFlowStateForType(req.params.type);
                if(retVal) {
                    return res.send(retVal);
                } else {
                    return res.status(404).send({error: `No such ${req.params.type} file`});
                }
            } else {
                return res.status(404).send({error: `Unrecognised flow type: ${req.params.type}`});
            }
        } catch (e) {
            return res.status(404).send();
        }
    });

    RED.httpAdmin.get( '/'+nodeName+'/flows', async function (req, res) {
        try {
            const retVal = {};
            for(const flowType of ['subflow', 'flow', 'global']) {
                retVal[flowType] = await getFlowStateForType(flowType);
            }
            return res.send(retVal);
        } catch (e) {
            return res.status(404).send();
        }
    });

    RED.httpAdmin.post( '/'+nodeName+'/flows', async function (req, res) {
        try {
            // calculate which flows to load (null means all flows, no filtering)
            let flowsToShow;
            const requestedToLoadAll = !req.body || req.body.length <= 0 || !Array.isArray(req.body);
            if(requestedToLoadAll) {
                flowsToShow = await readAllFlowFileNamesWithoutExt('flow');
            } else {
                flowsToShow = Array.from(
                    new Set([...flowManagerSettings.filter, ...req.body].concat(Array.from(onDemandFlowsManager.onDemandFlowsSet)))
                );
            }

            // calculate which of the loaded flows are "on-demand" flows
            await onDemandFlowsManager.updateOnDemandFlowsSet(new Set(flowsToShow));

            const loadFlowsPromise = (async function loadAndSetFlows() {
                const loadedFlowsInfo = await loadFlows(flowsToShow, true);
                const flowJson = loadedFlowsInfo.flows;
                if(flowJson && Array.isArray(flowJson) && flowJson.length) {
                    await PRIVATERED.nodes.setFlows(flowJson, null, 'flows');
                }
            })();

            await loadFlowsPromise;
            res.send({"status": "ok"});
        } catch(e) {
            res.status(404).send({error: e.stack});
        }
    });

    RED.httpAdmin.patch( '/'+nodeName+'/flow_visibility', bodyParser.json(), async function (req, res) {
        const patchObj = req.body;
        try {
            Object.assign(flowManagerSettings, patchObj);
            await onDemandFlowsManager.updateOnDemandFlowsSet(new Set());
            await fs.outputFile(directories.flowVisibilityJsonFilePath, stringifyFormattedFileJson(flowManagerSettings));
            await loadFlows(flowManagerSettings.filter, false);
            res.send({});
        } catch(e) {
            res.status(404).send();
        }
    });

    // serve libs
    RED.httpAdmin.use( '/'+nodeName+'/flow_visibility', serveStatic(path.join(directories.basePath, "flow_visibility.json")) );

    initialLoadPromise.resolve();
    initialLoadPromise = null;
}

module.exports = function(_RED) {
    RED = _RED;
    main();
};
