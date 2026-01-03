require("dotenv").config();
const express = require("express");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// Azure AI SDKs for file processing
const { AzureOpenAI } = require("@azure/openai");
const createImageAnalysisClient =
  require("@azure-rest/ai-vision-image-analysis").default;
const { AzureKeyCredential } = require("@azure/core-auth");

const app = express();
const PORT = process.env.PORT || 3000;

// ========== AZURE AI CLIENT INITIALIZATION ==========

// Azure OpenAI Client (GPT-4o for content quality analysis)
let openaiClient = null;
const OPENAI_DEPLOYMENT = "gpt-4o";

function getOpenAIClient() {
  if (
    !openaiClient &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_KEY
  ) {
    openaiClient = new AzureOpenAI({
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_KEY,
      apiVersion: "2024-02-15-preview",
    });
    console.log("Azure OpenAI client initialized.");
  }
  return openaiClient;
}

// Azure Vision Client (Image tagging and captioning)
let visionClient = null;

function getVisionClient() {
  if (!visionClient && process.env.VISION_ENDPOINT && process.env.VISION_KEY) {
    visionClient = createImageAnalysisClient(
      process.env.VISION_ENDPOINT,
      new AzureKeyCredential(process.env.VISION_KEY)
    );
    console.log("Azure Vision AI client initialized.");
  }
  return visionClient;
}

// ========== AI ANALYSIS FUNCTIONS ==========

// Content Safety Check (simplified - logs warning if not configured)
async function analyzeContentSafety(content, isImage = false) {
  // Content Safety SDK requires separate installation
  // For now, return safe by default with warning
  console.log("Content Safety check skipped (SDK not configured)");
  return { isSafe: true, reason: "Content Safety not configured" };
}

// GPT-4o Content Quality Analysis
async function analyzeContentQualityGPT4o(content, filename) {
  try {
    const client = getOpenAIClient();
    if (!client) {
      console.warn("OpenAI not configured - using default score");
      return {
        quality_score: 50,
        payout: 10,
        ai_analysis: { error: "OpenAI not configured" },
      };
    }

    const preview = content.substring(0, 8000);
    const prompt = `Analyze the following file named '${filename}'.
    
Determine:
1. Is this valid, high-quality code/text?
2. What does it do? (Short summary)
3. Assign a 'Trust Score' from 1 to 100 based on utility, cleanliness, and complexity.

Return ONLY a JSON object:
{
    "trust_score": <int>,
    "summary": "<string>",
    "reasoning": "<string>"
}

Content:
${preview}`;

    const response = await client.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [
        {
          role: "system",
          content: "You are a senior code auditor and data quality expert.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const resultJson = JSON.parse(response.choices[0].message.content);
    const score = resultJson.trust_score || 50;

    return {
      quality_score: score,
      payout: calculatePayout(score),
      ai_analysis: {
        summary: resultJson.summary,
        reasoning: resultJson.reasoning,
      },
    };
  } catch (e) {
    console.error("OpenAI analysis failed:", e.message);
    return { quality_score: 50, payout: 10, ai_analysis: { error: e.message } };
  }
}

// Azure Vision 4.0 Image Analysis
async function analyzeImageVision(imageBuffer) {
  try {
    const client = getVisionClient();
    if (!client) {
      console.warn("Vision AI not configured - using default analysis");
      return {
        tags: [],
        caption: "Vision AI not configured",
        ai_analysis: { error: "Not configured" },
      };
    }

    const response = await client.path("/imageanalysis:analyze").post({
      body: imageBuffer,
      queryParameters: {
        features: ["tags", "caption"],
      },
      contentType: "application/octet-stream",
    });

    if (response.status !== "200") {
      throw new Error(`Vision API error: ${response.status}`);
    }

    const result = response.body;
    const tags = result.tagsResult?.values?.map((t) => t.name) || [];
    const caption = result.captionResult?.text || "No caption generated";

    return {
      tags: tags,
      caption: caption,
      ai_analysis: {
        vision_model: "4.0",
        confidence: result.captionResult?.confidence || 0,
      },
    };
  } catch (e) {
    console.error("Vision analysis failed:", e.message);
    return {
      tags: [],
      caption: "Error in vision analysis",
      ai_analysis: { error: e.message },
    };
  }
}

// Classify content into market category using GPT-4o
async function classifyContent(description) {
  try {
    const client = getOpenAIClient();
    if (!client) return "General";

    const response = await client.chat.completions.create({
      model: OPENAI_DEPLOYMENT,
      messages: [
        {
          role: "system",
          content:
            "Classify this content into exactly ONE of these categories: 'Autonomous Driving', 'Medical Imaging', 'Robotics Training', 'Developer Tools', 'Financial Data', 'General'. Return only the category name.",
        },
        { role: "user", content: description },
      ],
    });

    return response.choices[0].message.content.trim();
  } catch (e) {
    console.error("Classification failed:", e.message);
    return "General";
  }
}

// Calculate payout based on quality score
function calculatePayout(qualityScore) {
  if (qualityScore < 50) {
    return Math.max(0.1, qualityScore * 0.1);
  } else if (qualityScore < 80) {
    return 5 + (qualityScore - 50) * 0.5;
  } else {
    return 20 + (qualityScore - 80) * 4.0;
  }
}

// Middleware
app.use(express.json());

// Serve static files
app.use("/Agency", express.static(path.join(__dirname, "Agency")));
app.use("/User", express.static(path.join(__dirname, "User")));
app.use(express.static(__dirname));

// Clean URL routes for legal pages
app.get("/terms", (req, res) =>
  res.sendFile(path.join(__dirname, "terms.html"))
);
app.get("/privacy", (req, res) =>
  res.sendFile(path.join(__dirname, "privacy.html"))
);
app.get("/refund", (req, res) =>
  res.sendFile(path.join(__dirname, "refund.html"))
);

// Azure Cosmos DB Configuration
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "mdatadb";

let database;
let usersContainer; // For contributor accounts
let agenciesContainer; // For agency/buyer accounts

async function initCosmos() {
  try {
    const client = new CosmosClient({ endpoint, key });

    // Get or create database
    const { database: db } = await client.databases.createIfNotExists({
      id: databaseId,
    });
    database = db;

    // Get or create Users container (for contributors)
    const { container: usersC } = await database.containers.createIfNotExists({
      id: "Users",
      partitionKey: { paths: ["/id"] },
    });
    usersContainer = usersC;
    console.log(`Connected to Azure Cosmos DB: ${databaseId} > Users`);

    // Get or create Agencies container (for buyers)
    const { container: agenciesC } =
      await database.containers.createIfNotExists({
        id: "Agencies",
        partitionKey: { paths: ["/id"] },
      });
    agenciesContainer = agenciesC;
    console.log(`Connected to Azure Cosmos DB: ${databaseId} > Agencies`);
  } catch (err) {
    console.error("Failed to connect to Cosmos DB:", err.message);
  }
}

initCosmos();

// Azure Storage Configuration
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  ContainerSASPermissions,
} = require("@azure/storage-blob");

const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
let blobServiceClient;
let containerClient;

try {
  if (storageConnectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      storageConnectionString
    );
    containerClient = blobServiceClient.getContainerClient("uploads");
    console.log("Connected to Azure Blob Storage.");
  } else {
    console.warn("AZURE_STORAGE_CONNECTION_STRING not found in .env");
  }
} catch (error) {
  console.error("Error connecting to Azure Blob Storage:", error.message);
}

// Helper: SHA256 Hash
function hashPassword(password, salt) {
  const hash = crypto.createHash("sha256");
  hash.update(password + salt);
  return hash.digest("hex");
}

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// API: Generate SAS Token
app.get("/api/storage/sas", async (req, res) => {
  try {
    if (!blobServiceClient || !containerClient) {
      return res.status(500).json({ error: "Storage not configured" });
    }

    const permissions = new ContainerSASPermissions();
    permissions.write = true;
    permissions.create = true;
    permissions.list = true;
    permissions.read = true; // Added read for initial check if needed

    const expiryDate = new Date();
    expiryDate.setMinutes(expiryDate.getMinutes() + 30);

    // Generate SAS for the container (simplest for uploads)
    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: "uploads",
        permissions: permissions,
        expiresOn: expiryDate,
      },
      blobServiceClient.credential
    ).toString();

    const sasUrl = `${containerClient.url}?${sasToken}`;
    res.json({ sasUrl });
  } catch (error) {
    console.error("SAS Gen Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: User Stats
app.get("/api/stats", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  try {
    const submissionsContainer = database.container("Submissions");
    // Ensure container exists logic is handled in Function App usually, but for reading we assume it exists or fail gracefully

    const querySpec = {
      query:
        "SELECT c.id, c.payout, c.quality_score, c.original_name, c.upload_timestamp, c.sold_to, c.transaction_date FROM c WHERE c.userId = @userId ORDER BY c.upload_timestamp DESC",
      parameters: [{ name: "@userId", value: userId }],
    };

    const { resources: items } = await submissionsContainer.items
      .query(querySpec)
      .fetchAll();

    let totalEarnings = 0.0;
    let totalScore = 0;
    const history = [];

    // Initialize map for last 30 days revenue
    const dailyMap = {};
    const today = new Date();
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(today.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dailyMap[`${yyyy}-${mm}-${dd}`] = 0; // Initialize with 0
    }

    items.forEach((item) => {
      const payout = item.payout || 0;
      const score = item.quality_score || 0;
      const isSold = !!item.sold_to;
      const userShare = isSold ? payout * 0.8 : 0;

      if (isSold) {
        totalEarnings += userShare;

        // Populate chart data
        if (item.transaction_date) {
          const tDate = item.transaction_date.split("T")[0];
          if (dailyMap.hasOwnProperty(tDate)) {
            dailyMap[tDate] += userShare;
          }
        }
      }
      totalScore += score;

      history.push({
        id: item.id,
        name: item.original_name || "Unknown",
        date: item.upload_timestamp
          ? item.upload_timestamp.split("T")[0]
          : "N/A",
        upload_date: item.upload_timestamp
          ? new Date(item.upload_timestamp).toLocaleDateString()
          : "N/A",
        quality_score: score,
        earnings: isSold ? `$${userShare.toFixed(2)}` : "$0.00",
        status: isSold ? "Sold" : item.status || "Pending",
        sold_to: item.sold_to || null,
      });
    });

    const avgQuality =
      items.length > 0 ? (totalScore / items.length).toFixed(1) : 0;

    // Convert dailyMap to sorted arrays for chart
    const sortedDates = Object.keys(dailyMap).sort();
    const chartData = sortedDates.map((date) => ({
      date,
      amount: parseFloat(dailyMap[date].toFixed(2)),
    }));

    res.json({
      earnings: `$${totalEarnings.toFixed(2)}`,
      quality: `${avgQuality}%`,
      total_uploads: items.length,
      history: history,
      revenue_analytics: chartData,
    });
  } catch (error) {
    console.error("Stats Error:", error);
    // Fallback for demo if DB read fails (avoiding empty screen in dev)
    res.json({
      earnings: "$0.00",
      quality: "0%",
      total_uploads: 0,
      history: [],
      revenue_analytics: [],
    });
  }
});

// API: File History
app.get("/api/files", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // Re-use logic or call stats logic? Let's just quick query for now.
  // Actually, the Stats API returns history, so we can probably reuse that or just specific query.
  // Let's implement a specific one for the history page to potentially support pagination later.
  try {
    const submissionsContainer = database.container("Submissions");
    const querySpec = {
      query:
        "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.upload_timestamp DESC",
      parameters: [{ name: "@userId", value: userId }],
    };
    const { resources: items } = await submissionsContainer.items
      .query(querySpec)
      .fetchAll();
    res.json(items);
  } catch (err) {
    console.error("Files Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Delete File
app.delete("/api/files/:fileId", async (req, res) => {
  const fileId = req.params.fileId;
  const userId = req.query.userId;

  if (!fileId || !userId) {
    return res.status(400).json({ error: "Missing fileId or userId" });
  }

  try {
    const submissionsContainer = container.database.container("Submissions");

    // Query for the file by id and userId to get the item and verify ownership
    const querySpec = {
      query: "SELECT * FROM c WHERE c.id = @fileId AND c.userId = @userId",
      parameters: [
        { name: "@fileId", value: fileId },
        { name: "@userId", value: userId },
      ],
    };

    const { resources: items } = await submissionsContainer.items
      .query(querySpec)
      .fetchAll();

    if (!items || items.length === 0) {
      return res.status(404).json({
        error: "File not found or you don't have permission to delete it",
      });
    }

    const item = items[0];

    // Check if already sold
    if (item.sold_to) {
      return res
        .status(400)
        .json({ error: "Cannot delete a file that has already been sold" });
    }

    // Delete the item from Cosmos DB - use userId as partition key
    await submissionsContainer.item(fileId, userId).delete();

    // Optionally delete from Blob Storage as well
    if (blobServiceClient && item.blob_url) {
      try {
        const blobName = item.blob_url.split("/").pop().split("?")[0];
        const blobClient = containerClient.getBlobClient(blobName);
        await blobClient.deleteIfExists();
        console.log(`Deleted blob: ${blobName}`);
      } catch (blobErr) {
        console.warn(
          "Failed to delete blob, but database record was removed:",
          blobErr.message
        );
      }
    }

    res.json({ message: "File deleted successfully", fileId });
  } catch (err) {
    console.error("Delete File Error:", err);
    res.status(500).json({ error: err.message || "Failed to delete file" });
  }
});

// API: Market Summaries
app.get("/api/market/summaries", async (req, res) => {
  try {
    const container = database.container("Submissions");
    const querySpec = {
      query: "SELECT c.market_category, c.quality_score, c.sold_to FROM c",
    };

    const { resources: items } = await container.items
      .query(querySpec)
      .fetchAll();

    const marketStats = {};
    items.forEach((item) => {
      if (item.sold_to) return; // Skip sold items

      const cat = item.market_category || "General";
      const score = item.quality_score || 0;

      if (!marketStats[cat]) {
        marketStats[cat] = { count: 0, sum_score: 0 };
      }
      marketStats[cat].count++;
      marketStats[cat].sum_score += score;
    });

    const result = Object.keys(marketStats).map((cat) => ({
      market_category: cat,
      total_files: marketStats[cat].count,
      avg_quality: (
        marketStats[cat].sum_score / marketStats[cat].count
      ).toFixed(1),
    }));

    // Mock if empty (for demo)
    if (result.length === 0) {
      result.push(
        {
          market_category: "Autonomous Driving",
          total_files: 1240,
          avg_quality: 94.5,
        },
        {
          market_category: "Medical Imaging",
          total_files: 850,
          avg_quality: 98.2,
        },
        {
          market_category: "Developer Tools",
          total_files: 2100,
          avg_quality: 91.5,
        }
      );
    }

    res.json(result);
  } catch (err) {
    console.error("Market Summaries Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Agency Purchases
app.get("/api/agency/purchases", async (req, res) => {
  try {
    const agencyId = req.query.agencyId;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const container = database.container("Submissions");
    const querySpec = {
      query:
        "SELECT c.id, c.original_name, c.market_category, c.sold_price, c.transaction_date, c.quality_score FROM c WHERE c.sold_to = @agencyId ORDER BY c.transaction_date DESC",
      parameters: [{ name: "@agencyId", value: agencyId }],
    };

    const { resources: items } = await container.items
      .query(querySpec)
      .fetchAll();
    res.json(items);
  } catch (err) {
    console.error("Agency Purchases Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Market Purchase
app.post("/api/market/purchase", async (req, res) => {
  try {
    const { category, agencyId } = req.body;
    if (!category || !agencyId)
      return res.status(400).json({ error: "Missing category or agencyId" });

    const container = database.container("Submissions");

    // 1. Fetch Items in Category
    const querySpec = {
      query: "SELECT * FROM c WHERE c.market_category = @category",
      parameters: [{ name: "@category", value: category }],
    };
    const { resources: items } = await container.items
      .query(querySpec)
      .fetchAll();

    // 2. Filter Unsold
    const unsoldItems = items.filter((i) => !i.sold_to);

    if (unsoldItems.length === 0) {
      return res
        .status(404)
        .json({ message: "No available datasets in this category." });
    }

    // 3. Buy top 5
    const itemsToBuy = unsoldItems.slice(0, 5);
    const purchasedCount = itemsToBuy.length;
    const totalBatchValue = purchasedCount * 25.0;
    const totalQualityScore = itemsToBuy.reduce(
      (sum, item) => sum + (item.quality_score || 0),
      0
    );

    // 4. Update Items
    for (const item of itemsToBuy) {
      item.sold_to = agencyId;
      item.transaction_date = new Date().toISOString();
      const itemQuality = item.quality_score || 0;

      let itemPayout = 0;
      if (totalQualityScore > 0) {
        itemPayout = totalBatchValue * (itemQuality / totalQualityScore);
      } else {
        itemPayout = totalBatchValue / purchasedCount;
      }

      item.payout = itemPayout;
      item.sold_price = itemPayout; // Agency view

      await container.items.upsert(item);
    }

    res.json({
      message: `Successfully purchased ${purchasedCount} items in '${category}'.`,
      count: purchasedCount,
      total_cost: totalBatchValue,
      note: "Payouts distributed to contributors based on AQI.",
    });
  } catch (err) {
    console.error("Purchase Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Market Bulk Checkout
app.post("/api/market/checkout", async (req, res) => {
  try {
    const { items, agencyId } = req.body; // items: [{ category: '...' }]
    if (!items || !Array.isArray(items) || !agencyId)
      return res.status(400).json({ error: "Invalid checkout data" });

    const container = database.container("Submissions");
    let totalPurchased = 0;
    let totalCost = 0;

    for (const cartItem of items) {
      const category = cartItem.category;

      // 1. Fetch Items
      const querySpec = {
        query: "SELECT * FROM c WHERE c.market_category = @category",
        parameters: [{ name: "@category", value: category }],
      };
      const { resources: allItems } = await container.items
        .query(querySpec)
        .fetchAll();
      const unsoldItems = allItems.filter((i) => !i.sold_to);

      if (unsoldItems.length > 0) {
        // Buy top 5
        const itemsToBuy = unsoldItems.slice(0, 5);
        const count = itemsToBuy.length;
        const batchValue = count * 25.0;
        totalCost += batchValue;
        totalPurchased += count;

        const totalQuality = itemsToBuy.reduce(
          (sum, i) => sum + (i.quality_score || 0),
          0
        );

        for (const item of itemsToBuy) {
          item.sold_to = agencyId;
          item.transaction_date = new Date().toISOString();
          const q = item.quality_score || 0;
          const payout =
            totalQuality > 0
              ? batchValue * (q / totalQuality)
              : batchValue / count;
          item.sold_price = payout;
          item.payout = payout;
          await container.items.upsert(item);
        }
      }
    }

    res.json({
      message: `Processed checkout. Bought ${totalPurchased} total datasets across ${items.length} bundles.`,
      total_cost: totalCost,
    });
  } catch (err) {
    console.error("Checkout Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Login
app.post("/api/login", async (req, res) => {
  const { email, password, role } = req.body;

  // Determine which container to use based on role
  const targetContainer =
    role === "agency" ? agenciesContainer : usersContainer;
  const accountType = role === "agency" ? "agency" : "user";

  if (!targetContainer) {
    return res
      .status(500)
      .json({ success: false, error: "Database not connected" });
  }

  try {
    // Query account by email in the appropriate container
    const querySpec = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    };

    const { resources: items } = await targetContainer.items
      .query(querySpec)
      .fetchAll();

    if (items.length === 0) {
      // Account not found in the target container
      const errorMessage =
        role === "agency"
          ? "No agency account found with this email. Please create an agency account to access the marketplace."
          : "No user account found with this email. Please create an account to start earning from your data.";

      return res.status(404).json({
        success: false,
        error: errorMessage,
        errorType: "ACCOUNT_NOT_FOUND",
        accountType: accountType,
      });
    }

    const user = items[0];

    // Verify Password
    const inputHash = hashPassword(password, user.salt);
    if (inputHash !== user.password_hash) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid password. Please try again." });
    }

    console.log(
      `${accountType.charAt(0).toUpperCase() + accountType.slice(1)} ${
        user.name
      } logged in successfully.`
    );

    const redirectUrl =
      role === "agency" ? "/Agency/dashboard.html" : "/User/dashboard.html";

    res.json({
      success: true,
      redirect: redirectUrl,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: role || user.role,
        balance: user.balance || 0,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// API: Signup
app.post("/api/signup", async (req, res) => {
  const { email, password, name, role } = req.body;

  // Determine which container to use based on role
  const targetContainer =
    role === "agency" ? agenciesContainer : usersContainer;
  const accountType = role === "agency" ? "agency" : "contributor";

  if (!targetContainer) {
    return res
      .status(500)
      .json({ success: false, error: "Database not connected" });
  }

  try {
    // Check if email already exists in target container
    const querySpec = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    };
    const { resources: existing } = await targetContainer.items
      .query(querySpec)
      .fetchAll();

    if (existing.length > 0) {
      const errorMessage =
        role === "agency"
          ? "An agency account already exists with this email. Please sign in instead."
          : "A user account already exists with this email. Please sign in instead.";
      return res.status(409).json({
        success: false,
        error: errorMessage,
        errorType: "EMAIL_EXISTS",
      });
    }

    // Create Account
    const salt = crypto.randomBytes(16).toString("hex");
    const password_hash = hashPassword(password, salt);
    const newAccount = {
      id: crypto.randomUUID(),
      name: name || (role === "agency" ? "New Agency" : "New User"),
      email: email,
      password_hash: password_hash,
      salt: salt,
      role: accountType,
      balance: 0.0,
      joined_date: new Date().toISOString(),
    };

    await targetContainer.items.create(newAccount);
    console.log(
      `${accountType.charAt(0).toUpperCase() + accountType.slice(1)} ${
        newAccount.name
      } created in ${role === "agency" ? "Agencies" : "Users"} container.`
    );

    const redirectUrl =
      role === "agency" ? "/Agency/dashboard.html" : "/User/dashboard.html";

    res.status(201).json({
      success: true,
      redirect: redirectUrl,
      user: {
        id: newAccount.id,
        name: newAccount.name,
        email: newAccount.email,
        role: newAccount.role,
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ========== AGENCY CART APIs (Cloud Storage) ==========

// GET agency cart
app.get("/api/agency/cart", async (req, res) => {
  try {
    const agencyId = req.query.agencyId;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const { resource: agency } = await agenciesContainer
      .item(agencyId, agencyId)
      .read();

    if (!agency) {
      return res.json({ cart: [] });
    }

    res.json({ cart: agency.cart || [] });
  } catch (err) {
    if (err.code === 404) {
      return res.json({ cart: [] });
    }
    console.error("Get Cart Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ADD item to agency cart
app.post("/api/agency/cart", async (req, res) => {
  try {
    const { agencyId, item } = req.body;
    if (!agencyId || !item)
      return res.status(400).json({ error: "Missing agencyId or item" });

    // Get current agency
    let agency;
    try {
      const { resource } = await agenciesContainer
        .item(agencyId, agencyId)
        .read();
      agency = resource;
    } catch (e) {
      if (e.code === 404) {
        return res.status(404).json({ error: "Agency not found" });
      }
      throw e;
    }

    // Initialize cart if not exists
    if (!agency.cart) agency.cart = [];

    // Check for duplicates
    const existing = agency.cart.find((c) => c.category === item.category);
    if (existing) {
      return res
        .status(409)
        .json({ error: `${item.category} Bundle is already in your cart.` });
    }

    // Add item
    agency.cart.push({
      id: crypto.randomUUID(),
      ...item,
      addedAt: new Date().toISOString(),
    });

    await agenciesContainer.items.upsert(agency);
    res.json({ success: true, cart: agency.cart });
  } catch (err) {
    console.error("Add to Cart Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// REMOVE item from agency cart
app.delete("/api/agency/cart/:itemId", async (req, res) => {
  try {
    const agencyId = req.query.agencyId;
    const itemId = req.params.itemId;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const { resource: agency } = await agenciesContainer
      .item(agencyId, agencyId)
      .read();

    if (!agency || !agency.cart) {
      return res.json({ success: true, cart: [] });
    }

    agency.cart = agency.cart.filter(
      (c) => c.id !== itemId && c.category !== itemId
    );
    await agenciesContainer.items.upsert(agency);

    res.json({ success: true, cart: agency.cart });
  } catch (err) {
    console.error("Remove from Cart Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// CLEAR agency cart
app.delete("/api/agency/cart", async (req, res) => {
  try {
    const agencyId = req.query.agencyId;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const { resource: agency } = await agenciesContainer
      .item(agencyId, agencyId)
      .read();

    if (agency) {
      agency.cart = [];
      await agenciesContainer.items.upsert(agency);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Clear Cart Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========== AGENCY PROFILE APIs ==========

// GET agency profile
app.get("/api/agency/profile", async (req, res) => {
  try {
    const agencyId = req.query.agencyId;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const { resource: agency } = await agenciesContainer
      .item(agencyId, agencyId)
      .read();

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    res.json({
      id: agency.id,
      name: agency.name,
      email: agency.email,
      phone: agency.phone || "",
      website: agency.website || "",
      description: agency.description || "",
      avatar: agency.avatar || null,
      joined_date: agency.joined_date,
    });
  } catch (err) {
    console.error("Get Profile Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE agency profile
app.put("/api/agency/profile", async (req, res) => {
  try {
    const { agencyId, name, phone, website, description, avatar } = req.body;
    if (!agencyId) return res.status(400).json({ error: "Missing agencyId" });

    const { resource: agency } = await agenciesContainer
      .item(agencyId, agencyId)
      .read();

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Update fields
    if (name !== undefined) agency.name = name;
    if (phone !== undefined) agency.phone = phone;
    if (website !== undefined) agency.website = website;
    if (description !== undefined) agency.description = description;
    if (avatar !== undefined) agency.avatar = avatar;

    await agenciesContainer.items.upsert(agency);

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: {
        id: agency.id,
        name: agency.name,
        email: agency.email,
        phone: agency.phone,
        website: agency.website,
        description: agency.description,
        avatar: agency.avatar,
      },
    });
  } catch (err) {
    console.error("Update Profile Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===========================================
// In-House OTP System with Nodemailer
// ===========================================

// In-memory OTP storage (for production, use Redis or database)
const otpStore = new Map();

// Email transporter configuration
// Uses Gmail by default - requires SMTP_USER and SMTP_PASS in .env
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Gmail App Password (not regular password)
  },
});

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// OTP Email HTML Template
function getOTPEmailTemplate(otp) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0f172a; padding: 40px 20px;">
        <tr>
          <td align="center">
            <table width="100%" max-width="500" cellpadding="0" cellspacing="0" style="max-width: 500px;">
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); border-radius: 16px 16px 0 0; padding: 30px; text-align: center;">
                  <h1 style="color: white; margin: 0; font-size: 28px; font-weight: bold;">MData</h1>
                  <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px;">Verify Your Email Address</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="background-color: #1e293b; padding: 40px 30px; text-align: center;">
                  <p style="color: #94a3b8; margin: 0 0 20px 0; font-size: 16px;">Your One-Time Password (OTP) is:</p>
                  <div style="background-color: #0f172a; border: 2px solid #3b82f6; border-radius: 12px; padding: 20px; margin: 20px 0;">
                    <span style="color: #3b82f6; font-size: 36px; font-weight: bold; letter-spacing: 8px;">${otp}</span>
                  </div>
                  <p style="color: #64748b; margin: 20px 0 0 0; font-size: 14px;">This code expires in <strong style="color: #f59e0b;">10 minutes</strong></p>
                  <p style="color: #475569; margin: 20px 0 0 0; font-size: 13px;">If you didn't request this code, please ignore this email.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color: #0f172a; border-radius: 0 0 16px 16px; padding: 20px; text-align: center; border-top: 1px solid #334155;">
                  <p style="color: #475569; margin: 0; font-size: 12px;">© 2024 MData. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

// Generate and send OTP
app.post("/api/otp/generate", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Check if SMTP is configured
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error("SMTP credentials not configured");
      return res.status(500).json({
        error: "Email service not configured",
        message: "Please configure SMTP_USER and SMTP_PASS in .env",
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore.set(email.toLowerCase(), { otp, expiresAt });

    // Send email
    const mailOptions = {
      from: `"MData" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Verify Your Email - MData",
      html: getOTPEmailTemplate(otp),
    };

    await transporter.sendMail(mailOptions);

    console.log(`OTP sent to ${email}`);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    console.error("OTP Generate Error:", err);
    res.status(500).json({
      error: "Failed to send OTP",
      message: err.message,
    });
  }
});

// Verify OTP
app.post("/api/otp/verify", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const stored = otpStore.get(email.toLowerCase());

    if (!stored) {
      return res.status(400).json({
        error: "OTP not found",
        message:
          "No OTP was generated for this email. Please request a new one.",
      });
    }

    if (Date.now() > stored.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({
        error: "OTP expired",
        message: "This OTP has expired. Please request a new one.",
      });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({
        error: "Invalid OTP",
        message: "The OTP you entered is incorrect. Please try again.",
      });
    }

    // OTP verified successfully - remove it
    otpStore.delete(email.toLowerCase());
    console.log(`OTP verified for ${email}`);

    res.json({ success: true, message: "OTP verified successfully" });
  } catch (err) {
    console.error("OTP Verify Error:", err);
    res.status(500).json({
      error: "Failed to verify OTP",
      message: err.message,
    });
  }
});

// ========== AI FILE PROCESSING API ==========
// This endpoint replaces the Azure Functions blob trigger
// Frontend calls this after successful blob upload

app.post("/api/process-file", async (req, res) => {
  try {
    const { blobName, userId, originalName, fileSize } = req.body;

    if (!blobName || !userId) {
      return res.status(400).json({ error: "Missing blobName or userId" });
    }

    console.log(`Processing file: ${blobName} for user: ${userId}`);

    const filename = originalName || blobName;
    const fileExtension = path.extname(filename).toLowerCase();

    // Initialize metadata
    const metadata = {
      id: blobName,
      userId: userId,
      original_name: filename,
      size: fileSize || 0,
      upload_timestamp: new Date().toISOString(),
      processed: true,
      analysis_type: "unknown",
      tags: [],
      caption: "",
      quality_score: 0,
      payout: 0,
      market_category: "Uncategorized",
      ai_analysis: {},
      is_safe: true,
      safety_reason: "Safe",
    };

    // Get the blob content for analysis
    let blobContent = null;
    let contentString = "";

    try {
      if (containerClient) {
        const blobClient = containerClient.getBlobClient(blobName);
        const downloadResponse = await blobClient.download();
        const chunks = [];
        for await (const chunk of downloadResponse.readableStreamBody) {
          chunks.push(chunk);
        }
        blobContent = Buffer.concat(chunks);

        // For text-based files, decode to string
        if (
          [
            ".txt",
            ".py",
            ".dart",
            ".js",
            ".md",
            ".json",
            ".html",
            ".css",
            ".ts",
            ".jsx",
            ".tsx",
          ].includes(fileExtension)
        ) {
          contentString = blobContent.toString("utf-8");
        }
      }
    } catch (downloadErr) {
      console.error(
        "Failed to download blob for analysis:",
        downloadErr.message
      );
      // Continue with default analysis if download fails
    }

    // Perform AI Analysis based on file type
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(fileExtension)) {
      metadata.analysis_type = "image";

      if (blobContent) {
        const visionResult = await analyzeImageVision(blobContent);
        metadata.tags = visionResult.tags;
        metadata.caption = visionResult.caption;
        metadata.ai_analysis = visionResult.ai_analysis;

        // Score based on richness of tags
        const score = Math.min(visionResult.tags.length * 10, 100);
        metadata.quality_score = score;
        metadata.payout = calculatePayout(score);

        // Classify based on tags
        metadata.market_category = await classifyContent(
          `Image with tags: ${visionResult.tags.join(", ")}`
        );
      } else {
        metadata.quality_score = 50;
        metadata.payout = 10;
      }
    } else if (
      [
        ".txt",
        ".py",
        ".dart",
        ".js",
        ".md",
        ".json",
        ".html",
        ".css",
        ".ts",
        ".jsx",
        ".tsx",
      ].includes(fileExtension)
    ) {
      metadata.analysis_type = "code_or_text";

      if (contentString) {
        const aiResult = await analyzeContentQualityGPT4o(
          contentString,
          filename
        );
        metadata.quality_score = aiResult.quality_score;
        metadata.payout = aiResult.payout;
        metadata.ai_analysis = aiResult.ai_analysis;

        // Classify based on content
        metadata.market_category = await classifyContent(
          `Code/Text file named ${filename}. Summary: ${
            aiResult.ai_analysis?.summary || "N/A"
          }`
        );
      } else {
        metadata.quality_score = 50;
        metadata.payout = 10;
        metadata.ai_analysis = {
          info: "Content could not be read for analysis.",
        };
      }
    } else {
      metadata.analysis_type = "other";
      metadata.ai_analysis = {
        info: "File type not supported for deep AI analysis yet.",
      };
      metadata.quality_score = 10;
      metadata.payout = 0.5;
    }

    // Store metadata in Cosmos DB Submissions container
    const submissionsContainer = database.container("Submissions");
    await submissionsContainer.items.upsert(metadata);

    console.log(
      `SUCCESS: File ${filename} processed with Score: ${metadata.quality_score}`
    );

    res.json({
      success: true,
      message: "File processed successfully",
      metadata: {
        id: metadata.id,
        quality_score: metadata.quality_score,
        payout: metadata.payout,
        market_category: metadata.market_category,
        analysis_type: metadata.analysis_type,
      },
    });
  } catch (err) {
    console.error("Process File Error:", err);
    res.status(500).json({ error: err.message || "Failed to process file" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
