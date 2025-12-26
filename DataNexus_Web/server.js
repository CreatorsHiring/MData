const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from Agency and User directories
app.use("/Agency", express.static(path.join(__dirname, "Agency")));
app.use("/User", express.static(path.join(__dirname, "User")));

// Serve other static assets if any (images, styles etc in root)
app.use(express.static(__dirname));

// Landing page route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landingpage.html"));
});

// Mock Login API
app.post("/api/login", (req, res) => {
  const { email, password, role } = req.body;

  console.log(`Login attempt: ${email} as ${role}`);

  // Simple mock logic: any login is successful
  // In a real app, you would verify credentials here

  if (role === "agency") {
    res.json({ success: true, redirect: "/Agency/dashboard.html" });
  } else {
    res.json({ success: true, redirect: "/User/dashboard.html" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
