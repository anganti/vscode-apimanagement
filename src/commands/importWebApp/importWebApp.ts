/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiManagementModels } from "azure-arm-apimanagement";
import { ApiContract, BackendContract, BackendCredentialsContract, OperationCollection, OperationContract } from "azure-arm-apimanagement/lib/models";
import WebSiteManagementClient from "azure-arm-website";
import { Site, WebAppCollection } from "azure-arm-website/lib/models";
import { ProgressLocation, window } from "vscode";
import xml = require("xml");
import { IOpenApiImportObject, OpenApiParser } from "../../../extension.bundle";
import { IWebAppContract } from "../../azure/webApp/contracts";
import * as Constants from "../../constants";
import { ApisTreeItem } from "../../explorer/ApisTreeItem";
import { ApiTreeItem } from "../../explorer/ApiTreeItem";
import { ServiceTreeItem } from "../../explorer/ServiceTreeItem";
import { ext } from "../../extensionVariables";
import { localize } from "../../localize";
import { apiUtil } from "../../utils/apiUtil";
import { azureClientUtil } from "../../utils/azureClientUtil";
import { processError } from "../../utils/errorUtil";
import { nonNullOrEmptyValue, nonNullValue } from "../../utils/nonNull";
import { requestUtil } from "../../utils/requestUtil";

export async function importWebAppToApi(node?: ApiTreeItem): Promise<void> {
    if (!node) {
        node = <ApiTreeItem>await ext.tree.showTreeItemPicker(ApiTreeItem.contextValue);
    }

    ext.outputChannel.show();
    ext.outputChannel.appendLine(localize("importWebApp", "Import Web App started..."));

    ext.outputChannel.appendLine(localize("importWebApp", "Getting Web App to import..."));
    const pickedWebApp: Site = await getPickedWebApp(node, "webApp");
    const resourceGroup = nonNullOrEmptyValue(pickedWebApp.resourceGroup);
    const webAppName = nonNullOrEmptyValue(pickedWebApp.name);
    const webConfigbaseUrl = `${node.root.environment.resourceManagerEndpointUrl}/subscriptions/${node.root.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.web/sites/${webAppName}/config/web?api-version=${Constants.webAppApiVersion20190801}`;
    ext.outputChannel.appendLine(localize("importWebApp", "Getting picked Web App's config..."));
    const webAppConfigStr: string = await requestUtil(webConfigbaseUrl, node.root.credentials, "GET");

    // tslint:disable: no-unsafe-any
    const webAppConfig: IWebAppContract = JSON.parse(webAppConfigStr);
    if (webAppConfig.properties.apiDefinition && webAppConfig.properties.apiDefinition.url) {
        ext.outputChannel.appendLine(localize("importWebApp", "Importing Web App from swagger object..."));
        // tslint:disable-next-line: no-non-null-assertion
        await importFromSwagger(webAppConfig, webAppName, node!.root.apiName, node!);
    } else {
        ext.outputChannel.appendLine(localize("importWebApp", "Can't find swagger object to import for this web app..."));
    }
}

export async function importWebApp(node?: ApisTreeItem): Promise<void> {
    if (!node) {
        const serviceNode = <ServiceTreeItem>await ext.tree.showTreeItemPicker(ServiceTreeItem.contextValue);
        node = serviceNode.apisTreeItem;
    }

    ext.outputChannel.show();
    ext.outputChannel.appendLine(localize("importWebApp", "Import Web App started..."));

    ext.outputChannel.appendLine(localize("importWebApp", "Getting Web App to import..."));
    const pickedWebApp: Site = await getPickedWebApp(node, "webApp");
    const resourceGroup = nonNullOrEmptyValue(pickedWebApp.resourceGroup);
    const webAppName = nonNullOrEmptyValue(pickedWebApp.name);
    const webConfigbaseUrl = `${node.root.environment.resourceManagerEndpointUrl}/subscriptions/${node.root.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.web/sites/${webAppName}/config/web?api-version=${Constants.webAppApiVersion20190801}`;
    ext.outputChannel.appendLine(localize("importWebApp", "Getting picked Web App's config..."));
    const webAppConfigStr: string = await requestUtil(webConfigbaseUrl, node.root.credentials, "GET");

    // tslint:disable-next-line: no-unsafe-any
    const webAppConfig: IWebAppContract = JSON.parse(webAppConfigStr);
    const apiName = await apiUtil.askApiName(webAppName);
    if (webAppConfig.properties.apiDefinition && webAppConfig.properties.apiDefinition.url) {
        ext.outputChannel.appendLine(localize("importWebApp", "Importing Web App from swagger object..."));
        await importFromSwagger(webAppConfig, webAppName, apiName, node);
    } else {
        window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: localize("importWebApp", `Importing Web App '${webAppName}' to API Management service ${node.root.serviceName} ...`),
                cancellable: false
            },
            // tslint:disable-next-line:no-non-null-assertion
            async () => {
                ext.outputChannel.appendLine(localize("importWebApp", "Importing Web App from wildcard..."));
                const apiId = apiUtil.genApiId(apiName);
                ext.outputChannel.appendLine(localize("importWebApp", "Creating new API..."));
                const nApi = await constructApiFromWebApp(apiId, pickedWebApp, apiName);
                await node!.createChild({ apiName, apiContract: nApi });
                const serviceUrl = "https://".concat(nonNullOrEmptyValue(nonNullValue(pickedWebApp.hostNames)[0]));
                const backendId = `WebApp_${apiUtil.displayNameToIdentifier(webAppName)}`;
                ext.outputChannel.appendLine(localize("importWebApp", "Checking backend entity..."));
                await setAppBackendEntity(node!, backendId, apiName, serviceUrl, resourceGroup, webAppName);
                ext.outputChannel.appendLine(localize("importWebApp", "Creating policies..."));
                await node!.root.client.apiPolicy.createOrUpdate(node!.root.resourceGroupName, node!.root.serviceName, apiName, {
                    format: "rawxml",
                    value: createImportXmlPolicy(backendId)
                });
                ext.outputChannel.appendLine(localize("importWebApp", "Create operations for API..."));
                const operations = await getWildcardOperationsForApi(apiId, apiName);
                for (const operation of operations) {
                    await node!.root.client.apiOperation.createOrUpdate(node!.root.resourceGroupName, node!.root.serviceName, apiName, nonNullOrEmptyValue(operation.name), operation);
                }
                ext.outputChannel.appendLine(localize("importWebApp", "Import Web App succeed!"));
            }
        ).then(async () => {
            // tslint:disable-next-line:no-non-null-assertion
            await node!.refresh();
            window.showInformationMessage(localize("importWebApp", `Imported Web App '${webAppName}' to API Management succesfully.`));
        });
    }
}

export async function getPickedWebApp(node: ApiTreeItem | ApisTreeItem, webAppType: string): Promise<Site> {
    const client = azureClientUtil.getClient(node.root.credentials, node.root.subscriptionId, node.root.environment);
    const allfunctionApps = await listWebApps(client, webAppType);
    return await pickWebApp(allfunctionApps);
}

export async function listWebApps(client: WebSiteManagementClient, webAppType: string): Promise<Site[]> {
    const allWebApps: WebAppCollection = await client.webApps.list();
    if ((webAppType === "webApp")) {
        return allWebApps.filter((ele) => !!ele.kind && !ele.kind.includes("functionapp"));
    }
    return allWebApps.filter((ele) => !!ele.kind && ele.kind.includes("functionapp"));
}

export async function pickWebApp(apiApps: Site[]): Promise<Site> {
    // Pick function app
    const apiApp = await ext.ui.showQuickPick(apiApps.map((s) => { return { label: nonNullOrEmptyValue(s.name), site: s }; }), { canPickMany: false });
    return apiApp.site;
}

// Create policy for importing
export function createImportXmlPolicy(backendId: string): string {
    const operationPolicy = [{
        policies: [
            {
                inbound: [
                    { base: null },
                    {
                        "set-backend-service": [
                            {
                                _attr: {
                                    id: "apim-generated-policy",
                                    "backend-id": backendId
                                }
                            }
                        ]
                    }
                ]
            },
            { backend: [{ base: null }] },
            { outbound: [{ base: null }] },
            { "on-error": [{ base: null }] }
        ]
    }];

    return xml(operationPolicy);
}

// Create backend for the web app
export async function setAppBackendEntity(node: ApisTreeItem | ApiTreeItem, backendId: string, appName: string, appPath: string, appResourceGroup: string, webAppName: string, BackendCredentials?: BackendCredentialsContract): Promise<void> {
    const nbackend: BackendContract = {
        description: `${appName}`,
        resourceId: `${node.root.environment.resourceManagerEndpointUrl}/subscriptions/${node.root.subscriptionId}/resourceGroups/${appResourceGroup}/providers/Microsoft.Web/sites/${webAppName}`,
        url: appPath,
        id: backendId,
        name: backendId,
        protocol: "http",
        credentials: BackendCredentials
    };
    await node.root.client.backend.createOrUpdate(node.root.resourceGroupName, node.root.serviceName, backendId, nbackend);
}

// Create new api from web app
export async function constructApiFromWebApp(apiId: string, webApp: Site, apiName: string): Promise<ApiContract> {
    return {
        description: `Import from "${webApp.name}" Function App`,
        id: apiId,
        name: apiName,
        displayName: apiName,
        path: "",
        protocols: ["https"]
    };
}

async function importFromSwagger(webAppConfig: IWebAppContract, webAppName: string, apiName: string, node: ApiTreeItem | ApisTreeItem): Promise<void> {
    if (webAppConfig.properties.apiDefinition && webAppConfig.properties.apiDefinition.url) {
        const docStr: string = await requestUtil(webAppConfig.properties.apiDefinition.url);
        if (docStr !== undefined && docStr.trim() !== "") {
            ext.outputChannel.appendLine(localize("importWebApp", "Getting swagger object..."));
            const documentJson = JSON.parse(docStr);
            const document = await parseDocument(documentJson);
            window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: localize("importWebApp", `Importing Web App '${webAppName}' to API Management service ${node.root.serviceName} ...`),
                    cancellable: false
                },
                // tslint:disable-next-line:no-non-null-assertion
                async () => {
                    try {
                        if (node instanceof ApiTreeItem) {
                            ext.outputChannel.appendLine(localize("importWebApp", "Updating API..."));
                            const openApiImportPayload: ApiManagementModels.ApiCreateOrUpdateParameter = { displayName: apiName, path: apiName, format: '', value: '' };
                            openApiImportPayload.protocols = document.schemes === undefined ? ["https"] : document.schemes;
                            openApiImportPayload.format = document.importFormat;
                            openApiImportPayload.value = JSON.stringify(document.sourceDocument);
                            const options = { ifMatch: "*" };
                            await node.root.client.api.createOrUpdate(node.root.resourceGroupName, node.root.serviceName, apiName, openApiImportPayload, options);
                        } else {
                            ext.outputChannel.appendLine(localize("importWebApp", "Creating new API..."));
                            await node.createChild({ apiName: apiName, document: document });
                            ext.outputChannel.appendLine(localize("importWebApp", "Updating API service url..."));
                            const curApi = await node!.root.client.api.get(node!.root.resourceGroupName, node!.root.serviceName, apiName);
                            curApi.serviceUrl = "";
                            await node!.root.client.api.createOrUpdate(node!.root.resourceGroupName, node!.root.serviceName, apiName, curApi);
                        }
                        ext.outputChannel.appendLine(localize("importWebApp", "Import web App succeeded!"));
                    } catch (error) {
                        ext.outputChannel.appendLine(localize("importWebApp", String(error)));
                    }
                }
            ).then(async () => {
                // tslint:disable-next-line:no-non-null-assertion
                await node!.refresh();
                window.showInformationMessage(localize("importWebApp", `Imported Web App '${webAppName}' to API Management succesfully.`));
            });
        }
    }
}

async function getWildcardOperationsForApi(apiId: string, apiName: string, node?: ApiTreeItem): Promise<OperationContract[]> {
    const operations: OperationContract[] = [];
    const HttpMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE"];
    if (node) {
        const allOperations = await node.root.client.apiOperation.listByApi(node.root.resourceGroupName, node.root.serviceName, node.root.apiName);
        const existingOperationNames = getAllOperationNames(allOperations);
        const existingOperationDisplayNames = getAllOperationDisplayNames(allOperations);
        HttpMethods.forEach(method => {
            let operationId = getBsonObjectId();
            let operationDisName = `${apiName}_${method}`;
            if (existingOperationNames.includes(operationId) || existingOperationDisplayNames.includes(operationDisName)) {
                ext.outputChannel.appendLine(localize("importWebApp", "Resolving conflict operations..."));
                const subfix = genUniqueOperationNameSubfix(operationId, operationDisName, existingOperationNames, existingOperationDisplayNames);
                operationId = `${operationId}-${subfix}`;
                operationDisName = `${operationDisName}-${subfix}`;
            }
            const operation = getNewOperation(apiId, method, operationId, operationDisName);
            operations.push(operation);
        });
    } else {
        HttpMethods.forEach(method => {
            const operationId = getBsonObjectId();
            const operation = getNewOperation(apiId, method, operationId, `${apiName}_${method}`);
            operations.push(operation);
        });
    }
    return operations;
}

function getNewOperation(apiId: string, method: string, operationId: string, displayName: string): OperationContract {
    return {
        id: `${apiId}/operations/${operationId}`,
        name: operationId,
        displayName: displayName,
        method: method,
        description: "",
        urlTemplate: "*",
        templateParameters: []
    };
}

function getBsonObjectId(): string {
    // tslint:disable: no-bitwise
    const timestamp = (new Date().getTime() / 1000 | 0).toString(16);

    return timestamp + "xxxxxxxxxxxxxxxx".replace(/[x]/g, getRandomHex()).toLowerCase();
}

function getRandomHex(): string {
    // tslint:disable-next-line: insecure-random
    return (Math.random() * 16 | 0).toString(16);
}

// tslint:disable: no-any
async function parseDocument(documentJson: any): Promise<IOpenApiImportObject> {
    try {
        // tslint:disable-next-line: no-unsafe-any
        return await new OpenApiParser().parse(documentJson);
    } catch (error) {
        throw new Error(processError(error, localize("openApiJsonParseError", "Could not parse the provided OpenAPI document.")));
    }
}

function genUniqueOperationNameSubfix(opName: string, opDisName: string, existingOperationNames: string[], existingOperationDisplayNames: string[]): number {
    let cnt = 0;
    let curName = opName;
    while (existingOperationNames.includes(curName) || existingOperationDisplayNames.includes(opDisName)) {
        cnt++;
        curName = opName.concat("-", cnt.toString());
    }
    return cnt;
}

function getAllOperationNames(operations: OperationCollection): string[] {
    const operationNames: string[] = [];
    operations.forEach(ele => {
        operationNames.push(nonNullOrEmptyValue(ele.name));
    });
    return operationNames;
}

function getAllOperationDisplayNames(operations: OperationCollection): string[] {
    const operationNames: string[] = [];
    operations.forEach(ele => {
        operationNames.push(nonNullOrEmptyValue(ele.displayName));
    });
    return operationNames;
}
