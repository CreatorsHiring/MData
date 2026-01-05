# MData - Ethical AI Data Marketplace

> **Fueling AI with Ethical Data**

A marketplace where data contributors earn rewards for quality datasets, and AI agencies access verified training data.

**Live:** https://mdata.co.in

---

## 🚀 Features

- **For Contributors:** Upload datasets → AI analysis → Earn payouts based on quality
- **For Agencies:** Browse marketplace → Cart system → Purchase verified datasets
- **AI-Powered:** Gemini quality scoring, Vertex AI image tagging
- **Secure:** Email OTP auth, encrypted storage, SSL

---

## 🛠 Tech Stack

| Layer    | Technology                         |
| -------- | ---------------------------------- |
| Frontend | HTML, CSS, TailwindCSS, Vanilla JS |
| Backend  | Node.js 20, Express.js             |
| Database | Firebase Firestore (NoSQL)         |
| Storage  | Google Cloud Storage               |
| AI       | Google Gemini, Vertex AI Vision    |
| Hosting  | Azure App Service                  |
| CI/CD    | GitHub Actions                     |

---

## 📁 Project Structure

```
MData/
├── server.js          # Express server (all backend logic)
├── package.json       # Dependencies
├── index.html         # Landing page
├── User/              # Contributor portal
│   ├── login.html
│   ├── dashboard.html
│   └── upload_files.html
├── Agency/            # Agency portal
│   ├── login.html
│   ├── dashboard.html
│   └── marketplace.html
└── .github/workflows/ # CI/CD
```

---

## 🏃 Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Create .env file with:
# FIREBASE_PROJECT_ID=...
# FIREBASE_PRIVATE_KEY=...
# GCS_BUCKET_NAME=...
# SMTP_USER=...
# SMTP_PASS=...

# Run
node server.js
```

Open http://localhost:8080

### Deploy to Google Cloud

```bash
git add .
git commit -m "Your changes"
git push origin main
```

GitHub Actions auto-deploys to Google Cloud Run.

---

## 🔧 Environment Variables

| Variable               | Purpose              |
| ---------------------- | -------------------- |
| `FIREBASE_PROJECT_ID`  | Firebase project ID  |
| `FIREBASE_PRIVATE_KEY` | Firebase service key |
| `GCS_BUCKET_NAME`      | Cloud Storage bucket |
| `GEMINI_API_KEY`       | Gemini AI service    |
| `VERTEX_PROJECT_ID`    | Vertex AI project    |
| `VERTEX_LOCATION`      | Vertex AI region     |
| `SMTP_USER`            | Email (for OTP)      |
| `SMTP_PASS`            | Email app password   |

---

## 📊 API Endpoints

| Method | Endpoint            | Description    |
| ------ | ------------------- | -------------- |
| POST   | `/api/user/signup`  | Create user    |
| POST   | `/api/user/login`   | User login     |
| POST   | `/api/upload-sas`   | Get upload URL |
| POST   | `/api/process-file` | AI analysis    |
| GET    | `/api/datasets`     | List datasets  |

---

## 🏗 Architecture

```
User Browser → Google Cloud Run (Node.js)
                   ↓
          ┌───────┴───────┐
          ↓               ↓
    Firestore       Cloud Storage
          ↓               ↓
     Metadata         Files
          ↓
    ┌─────┴─────┐
    ↓           ↓
 Gemini    Vertex AI
```

---

## 📝 License

MIT

---

## 👨‍💻 Author

**Rahul Pujari**

- GitHub: [@Rahul-14507](https://github.com/Rahul-14507)
- Email: pujarirahul.pandu@gmail.com
