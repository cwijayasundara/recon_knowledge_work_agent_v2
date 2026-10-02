using './main.bicep'

param prefix = 'onbdev'
param apiImage = '<registry>/onb-api:dev'
param webImage = '<registry>/onb-web:dev'
param sandboxImage = '<registry>/onb-sandbox:dev'
param entraClientId = '<app-registration-client-id>'
param postgresAdminPassword = readEnvironmentVariable('ONB_PG_PASSWORD')
