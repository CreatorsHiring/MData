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
const containerId = "Users";

let container;

async function initCosmos() {
  try {
    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    container = database.container(containerId);
    console.log(`Connected to Azure Cosmos DB: ${databaseId} > ${containerId}`);
  } catch (err) {
    console.error("Failed to connect to Cosmos DB:", err.message);
  }
}

initCosmos();

// Helper: SHA256 Hash
function hashPassword(password, salt) {
  const hash = crypto.createHash("sha256");
  hash.update(password + salt);
  return hash.digest("hex");
}

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landingpage.html"));
});

// API: Login
app.post("/api/login", async (req, res) => {
  const { email, password, role } = req.body;

  if (!container) {
    return res
      .status(500)
      .json({ success: false, error: "Database not connected" });
  }

  try {
    // Query user by email
    const querySpec = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    };

    const { resources: items } = await container.items
      .query(querySpec)
      .fetchAll();

    if (items.length === 0) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid credentials" });
    }

    const user = items[0];

    // Verify Password
    const inputHash = hashPassword(password, user.salt);
    if (inputHash !== user.password_hash) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid credentials" });
    }

    // Verify Role (Optional: strict check or just guidance)
    // Note: The Python backend sets a default 'contributor' role.
    // We can allow users to login to either portal but redirect based on their stored role preference or requested role.

    console.log(`User ${user.name} logged in successfully.`);

    let redirectUrl = "/User/dashboard.html";
    if (role === "agency" || user.role === "agency") {
      redirectUrl = "/Agency/dashboard.html";
    }

    res.json({
      success: true,
      redirect: redirectUrl,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
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

  if (!container) {
    return res
      .status(500)
      .json({ success: false, error: "Database not connected" });
  }

  try {
    // Check availability
    const querySpec = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    };
    const { resources: existing } = await container.items
      .query(querySpec)
      .fetchAll();

    if (existing.length > 0) {
      return res
        .status(409)
        .json({ success: false, error: "Email already exists" });
    }

    // Create User
    const salt = crypto.randomBytes(16).toString("hex");
    const password_hash = hashPassword(password, salt);
    const newUser = {
      id: crypto.randomUUID(),
      name: name || "New User",
      email: email,
      password_hash: password_hash,
      salt: salt,
      role: role || "contributor",
      balance: 0.0,
      joined_date: new Date().toISOString(),
    };

    await container.items.create(newUser);
    console.log(`User ${newUser.name} created.`);

    const redirectUrl =
      role === "agency" ? "/Agency/dashboard.html" : "/User/dashboard.html";

    res.status(201).json({
      success: true,
      redirect: redirectUrl,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
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
