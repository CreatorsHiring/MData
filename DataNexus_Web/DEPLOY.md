# MData Azure Deployment Guide

## Prerequisites

- Azure CLI installed (`winget install Microsoft.AzureCLI`)
- Azure account with active subscription
- GitHub repository for the code

---

## Step 1: Create Azure Resources

### Login to Azure

```bash
az login
```

### Create Resource Group

```bash
az group create --name mdata-rg --location centralindia
```

### Create App Service Plan (Basic B1)

```bash
az appservice plan create \
  --name mdata-plan \
  --resource-group mdata-rg \
  --sku B1 \
  --is-linux
```

### Create Web App (Node.js)

```bash
az webapp create \
  --name mdata-web \
  --resource-group mdata-rg \
  --plan mdata-plan \
  --runtime "NODE:20-lts"
```

### Create Azure Functions App (Python)

```bash
az functionapp create \
  --name mdata-functions \
  --resource-group mdata-rg \
  --consumption-plan-location centralindia \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --storage-account mdatastorage \
  --os-type Linux
```

---

## Step 2: Configure Environment Variables

### For Web App

```bash
az webapp config appsettings set \
  --name mdata-web \
  --resource-group mdata-rg \
  --settings \
    COSMOS_ENDPOINT="your_cosmos_endpoint" \
    COSMOS_KEY="your_cosmos_key" \
    AZURE_STORAGE_CONNECTION_STRING="your_storage_connection" \
    SMTP_USER="your_gmail" \
    SMTP_PASS="your_app_password"
```

### For Functions App

```bash
az functionapp config appsettings set \
  --name mdata-functions \
  --resource-group mdata-rg \
  --settings \
    COSMOS_ENDPOINT="your_cosmos_endpoint" \
    COSMOS_KEY="your_cosmos_key" \
    AzureWebJobsStorage="your_storage_connection"
```

---

## Step 3: Setup GitHub Actions Secrets

1. Go to your GitHub repo → Settings → Secrets → Actions
2. Add these secrets:

### AZURE_WEBAPP_PUBLISH_PROFILE

```bash
# Get publish profile for web app
az webapp deployment list-publishing-profiles \
  --name mdata-web \
  --resource-group mdata-rg \
  --xml
```

Copy the entire XML output and add as secret.

### AZURE_FUNCTIONS_PUBLISH_PROFILE

```bash
# Get publish profile for functions
az functionapp deployment list-publishing-profiles \
  --name mdata-functions \
  --resource-group mdata-rg \
  --xml
```

---

## Step 4: Custom Domain Setup

### Add Custom Domain

```bash
az webapp config hostname add \
  --webapp-name mdata-web \
  --resource-group mdata-rg \
  --hostname mdata.co.in
```

### DNS Configuration

Add these records at your domain registrar:

| Type  | Name  | Value                        |
| ----- | ----- | ---------------------------- |
| CNAME | www   | mdata-web.azurewebsites.net  |
| A     | @     | (Azure IP from portal)       |
| TXT   | asuid | (Verification ID from Azure) |

### Enable Free SSL

```bash
az webapp config ssl create \
  --name mdata-web \
  --resource-group mdata-rg \
  --hostname mdata.co.in
```

---

## Step 5: Deploy

### Option A: Push to GitHub (Automatic)

```bash
git add .
git commit -m "Deploy to Azure"
git push origin main
```

GitHub Actions will automatically deploy.

### Option B: Manual Deploy via CLI

```bash
# Deploy web app
az webapp up --name mdata-web --resource-group mdata-rg

# Deploy functions
func azure functionapp publish mdata-functions
```

---

## Estimated Monthly Costs

| Resource        | SKU         | Cost (₹)         |
| --------------- | ----------- | ---------------- |
| App Service     | B1          | ~1,100           |
| Azure Functions | Consumption | ~0-100           |
| Cosmos DB       | Serverless  | ~300-500         |
| Blob Storage    | Standard    | ~50-100          |
| **Total**       |             | **~1,500-1,800** |

---

## Troubleshooting

### View Logs

```bash
az webapp log tail --name mdata-web --resource-group mdata-rg
```

### Restart App

```bash
az webapp restart --name mdata-web --resource-group mdata-rg
```

### Check Deployment Status

```bash
az webapp deployment list-publishing-credentials \
  --name mdata-web \
  --resource-group mdata-rg
```
