// Azure dev deployment for the onboarding workbench (Phase 9).
//   az deployment group create -g <rg> -f infra/main.bicep -p infra/dev.bicepparam
// Not yet deployed or validated against a subscription; see infra/README.md.

targetScope = 'resourceGroup'

@description('Short prefix for resource names, e.g. onbdev.')
@minLength(3)
@maxLength(12)
param prefix string
param location string = resourceGroup().location
param apiImage string
param webImage string
param sandboxImage string
@description('Entra ID app registration (client id) used by Container Apps built-in auth.')
param entraClientId string
@secure()
param postgresAdminPassword string
param postgresAdminUser string = 'onbadmin'
param supervisorDeployment string = 'gpt-6-astra'
param recipeEngineerDeployment string = 'gpt-5.6-sol'
param embeddingDeployment string = 'text-embedding-3-small'
@description('Model name and version for each deployment, as offered in the region.')
param models object = {
  'gpt-6-astra': { name: 'gpt-6-astra', version: 'latest', capacity: 50 }
  'gpt-5.6-sol': { name: 'gpt-5.6-sol', version: 'latest', capacity: 50 }
  'text-embedding-3-small': { name: 'text-embedding-3-small', version: '1', capacity: 50 }
}

var suffix = uniqueString(resourceGroup().id)
var roles = {
  openAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  sessionExecutor: '0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0'
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}

// ---- identity, monitoring -------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

// ---- network ---------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.4.0/24'
          delegations: [{ name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}

// ---- data --------------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}kv${take(suffix, 6)}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${prefix}st${take(suffix, 8)}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Locked runs are archived here; the time-based policy keeps them immutable.
resource lockedContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'locked-runs'
}

resource lockedPolicy 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: lockedContainer
  name: 'default'
  properties: { immutabilityPeriodSinceCreationInDays: 365, allowProtectedAppendWrites: false }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// The working object store (uploads, run directories, outputs) as a file share.
resource objectsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'objects'
  properties: { shareQuota: 100 }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${take(suffix, 6)}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    network: { delegatedSubnetResourceId: vnet.properties.subnets[1].id }
    highAvailability: { mode: 'Disabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'onboarding'
}

resource databaseUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    value: 'postgresql://${postgresAdminUser}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/onboarding?sslmode=require'
  }
}

// ---- models ------------------------------------------------------------------

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${prefix}-aoai-${take(suffix, 6)}'
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: { customSubDomainName: '${prefix}-aoai-${take(suffix, 6)}', disableLocalAuth: true }
}

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [
  for name in [supervisorDeployment, recipeEngineerDeployment, embeddingDeployment]: {
    parent: openai
    name: name
    sku: { name: 'GlobalStandard', capacity: models[name].capacity }
    properties: { model: { format: 'OpenAI', name: models[name].name, version: models[name].version } }
  }
]

// ---- container apps ------------------------------------------------------------

resource environment 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: '${prefix}-env'
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: vnet.properties.subnets[0].id, internal: false }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-10-02-preview' = {
  parent: environment
  name: 'objects'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: objectsShare.name
      accessMode: 'ReadWrite'
    }
  }
}

// The recipe engineer's sandbox: one session per run, no egress, no secrets.
resource sessionPool 'Microsoft.App/sessionPools@2024-10-02-preview' = {
  name: '${prefix}-sandbox'
  location: location
  properties: {
    environmentId: environment.id
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    scaleConfiguration: { maxConcurrentSessions: 20, readySessionInstances: 2 }
    dynamicPoolConfiguration: { executionType: 'Timed', cooldownPeriodInSeconds: 1800 }
    sessionNetworkConfiguration: { status: 'EgressDisabled' }
    customContainerTemplate: {
      containers: [
        {
          name: 'sandbox'
          image: sandboxImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
      ingress: { targetPort: 8080 }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${prefix}-api'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      // Internal only: the web app proxies /api to it, so the principal header can be trusted.
      ingress: { external: false, targetPort: 8000, transport: 'auto' }
      secrets: [
        { name: 'database-url', keyVaultUrl: databaseUrl.properties.secretUri, identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'ONB_MODEL_PROVIDER', value: 'azure_openai_v1' }
            { name: 'ONB_AZURE_OPENAI_BASE_URL', value: '${openai.properties.endpoint}openai/v1/' }
            { name: 'ONB_SUPERVISOR_MODEL', value: supervisorDeployment }
            { name: 'ONB_RECIPE_ENGINEER_MODEL', value: recipeEngineerDeployment }
            { name: 'ONB_EMBEDDING_MODEL', value: embeddingDeployment }
            { name: 'ONB_SANDBOX_BACKEND', value: 'aca' }
            { name: 'ONB_ACA_POOL_ENDPOINT', value: sessionPool.properties.poolManagementEndpoint }
            { name: 'ONB_DATABASE_URL', secretRef: 'database-url' }
            { name: 'ONB_OBJECT_ROOT', value: '/data/objects' }
            { name: 'ONB_TRUST_EASY_AUTH', value: 'true' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
          ]
          volumeMounts: [{ volumeName: 'objects', mountPath: '/data/objects' }]
        }
      ]
      volumes: [{ name: 'objects', storageType: 'AzureFile', storageName: envStorage.name }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource webAuth 'Microsoft.App/containerApps/authConfigs@2024-10-02-preview' = {
  parent: web
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: { unauthenticatedClientAction: 'RedirectToLoginPage' }
    identityProviders: {
      azureActiveDirectory: {
        registration: {
          clientId: entraClientId
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${subscription().tenantId}/v2.0'
        }
      }
    }
  }
}

resource web 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: '${prefix}-web'
  location: location
  properties: {
    environmentId: environment.id
    configuration: { ingress: { external: true, targetPort: 3000 } }
    template: {
      containers: [{ name: 'web', image: webImage, resources: { cpu: json('0.5'), memory: '1Gi' } }]
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
}

// ---- role assignments -----------------------------------------------------------

resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: openai
  name: guid(openai.id, identity.id, roles.openAiUser)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.openAiUser)
  }
}

resource sessionExecutor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sessionPool
  name: guid(sessionPool.id, identity.id, roles.sessionExecutor)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.sessionExecutor)
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, identity.id, roles.blobContributor)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobContributor)
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, roles.keyVaultSecretsUser)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}

output apiInternalUrl string = 'http://${api.name}'
output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output sessionPoolEndpoint string = sessionPool.properties.poolManagementEndpoint
