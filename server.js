const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const SHARED_DRIVE_ID = "0AGi8kzl6STpwUk9PVA";
const SERVICE_ACCOUNT_FILE =
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "/etc/secrets/credentials.json";

/* =========================
   ✅ PUBLIC 정적 서빙 (여기 중요)
========================= */
app.use(express.static(path.join(__dirname, "public")));

// 루트(/)로 들어오면 public/index.html 반환
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   GOOGLE AUTH
========================= */
if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  throw new Error("Service account file not found");
}

const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

/* =========================
   MULTER
   👉 input name 무조건 'file'
========================= */
const upload = multer({ dest: "uploads/" });

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* =========================
   FOLDER UTILS
========================= */
async function getOrCreateFolder(name, parentId) {
  if (!name || !name.trim()) throw new Error("Folder name is empty");

  const q = [
    `name='${name}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ].join(" and ");

  const list = await drive.files.list({
    q,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id, name)",
  });

  if (list.data.files.length > 0) return list.data.files[0].id;

  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
  });

  return created.data.id;
}

/* =========================
   UPLOAD API
========================= */
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file received (field name must be 'file')",
      });
    }

    const { date, category } = req.body;

    const rootFolderId = await getOrCreateFolder("공사사진", SHARED_DRIVE_ID);
    const dateFolderId = await getOrCreateFolder(date, rootFolderId);
    const categoryFolderId = await getOrCreateFolder(category, dateFolderId);

    const fileMetadata = {
      name: req.file.originalname,
      parents: [categoryFolderId],
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path),
    };

    const uploaded = await drive.files.create({
      requestBody: fileMetadata,
      media,
      supportsAllDrives: true,
    });

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      fileId: uploaded.data.id,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({
      success: false,
      message: "upload failed",
      error: err.message,
    });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
