require("dotenv").config();
const express = require("express");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Serve static files
app.use("/Agency", express.static(path.join(__dirname, "Agency")));
app.use("/User", express.static(path.join(__dirname, "User")));
app.use(express.static(__dirname));

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

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
