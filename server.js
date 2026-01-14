const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
   CONFIG
================================ */
const PORT = process.env.PORT || 10000;
const SHARED_DRIVE_ID = "0AGi8kzl6STpwUk9PVA";
const SERVICE_ACCOUNT_FILE =
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "/etc/secrets/credentials.json";

/* ===============================
   GOOGLE AUTH
================================ */
function getDrive() {
  if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    throw new Error("Service account file not found");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

/* ===============================
   MULTER (TEMP UPLOAD)
================================ */
const upload = multer({ dest: "uploads/" });

/* ===============================
   HEALTH CHECK
================================ */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ===============================
   GOOGLE DRIVE HELPERS
================================ */
async function getOrCreateFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
      driveId: SHARED_DRIVE_ID,
    },
    supportsAllDrives: true,
  });

  return folder.data.id;
}

/* ===============================
   UPLOAD API
================================ */
app.post("/upload", upload.array("photos"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: "No files uploaded",
      });
    }

    const {
      workDate,
      category,
      address,
      uploader,
    } = req.body;

    const drive = getDrive();

    // 폴더 구조
    const rootFolderId = await getOrCreateFolder(drive, "공사사진");
    const dateFolderId = await getOrCreateFolder(drive, workDate, rootFolderId);
    const categoryFolderId = await getOrCreateFolder(
      drive,
      category,
      dateFolderId
    );

    const uploadedFiles = [];

    for (const file of req.files) {
      if (!file.path || !fs.existsSync(file.path)) {
        continue;
      }

      const driveRes = await drive.files.create({
        requestBody: {
          name: file.originalname,
          parents: [categoryFolderId],
        },
        media: {
          body: fs.createReadStream(file.path),
        },
        supportsAllDrives: true,
      });

      uploadedFiles.push(driveRes.data.id);

      // temp 파일 삭제
      fs.unlinkSync(file.path);
    }

    if (uploadedFiles.length === 0) {
      return res.status(500).json({
        success: false,
        message: "upload failed",
        error: "File processing failed",
      });
    }

    res.json({
      success: true,
      files: uploadedFiles,
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

/* ===============================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
