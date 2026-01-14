const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "uploads/" });

// ✅ 공유드라이브 루트 “폴더 ID” (URL의 /folders/<ID>)
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "";
if (!DRIVE_ROOT_FOLDER_ID) {
  console.error("❌ Missing env DRIVE_ROOT_FOLDER_ID (shared drive root folder id from URL)");
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing env GOOGLE_SERVICE_ACCOUNT_JSON");
  const obj = JSON.parse(raw);
  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  return obj;
}

function getDriveClient() {
  const sa = getServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

function getSheetsClient() {
  const sa = getServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// (선택) 시트 기록용
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

function extractFields(body) {
  const date = body.date || body.workDate || body.work_date || "";
  const workType = body.workType || body.work_type || body.type || "";
  const address = body.address || body.addr || body.location || "";
  const uploader = body.uploader || body.uploaderName || body.name || "";
  const memo = body.memo || body.note || "";
  return { date, workType, address, uploader, memo };
}

// ✅ “부모 폴더 안에서” 폴더 찾기/생성 (driveId/corpora 안 씀)
async function findOrCreateFolder(drive, name, parentId) {
  const escaped = name.replace(/'/g, "\\'");
  const q = [
    `name='${escaped}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    "trashed=false",
    `'${parentId}' in parents`,
  ].join(" and ");

  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (list.data.files && list.data.files.length > 0) return list.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

async function uploadFileToDrive(drive, localPath, filename, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentId],
    },
    media: {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(localPath),
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  return res.data;
}

app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ✅ multipart: photos/photo/file 다 받기
const multiUpload = (req, res, next) => {
  const u1 = upload.array("photos", 30);
  const u2 = upload.array("photo", 30);
  const u3 = upload.array("file", 30);

  u1(req, res, (err) => {
    if (!err) return next();
    u2(req, res, (err2) => {
      if (!err2) return next();
      u3(req, res, (err3) => {
        if (!err3) return next();
        return next(err3);
      });
    });
  });
};

app.post("/upload", multiUpload, async (req, res) => {
  try {
    console.log("=== /upload hit ===");
    console.log("content-type:", req.headers["content-type"]);
    console.log("req.body:", req.body);
    console.log("files:", (req.files || []).map(f => ({
      fieldname: f.fieldname,
      originalname: f.originalname,
      size: f.size,
      path: f.path,
    })));

    if (!DRIVE_ROOT_FOLDER_ID) {
      return res.status(500).json({
        success: false,
        message: "upload failed",
        error: "Missing env DRIVE_ROOT_FOLDER_ID",
      });
    }

    const { date, workType, address, uploader, memo } = extractFields(req.body);

    const missing = [];
    if (!date) missing.push("date");
    if (!workType) missing.push("workType");
    if (!address) missing.push("address");
    if (!uploader) missing.push("uploader");

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: `Missing fields: ${missing.join("/")}`,
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: "No files uploaded",
      });
    }

    const drive = getDriveClient();

    // ✅ 공유드라이브 루트 폴더 아래에 공사사진/날짜/공종
    const rootFolderId = await findOrCreateFolder(drive, "공사사진", DRIVE_ROOT_FOLDER_ID);
    const dateFolderId = await findOrCreateFolder(drive, date, rootFolderId);
    const typeFolderId = await findOrCreateFolder(drive, workType, dateFolderId);

    const links = [];
    for (const f of req.files) {
      const safeOriginal = (f.originalname || "file").replace(/[\\/:*?"<>|]/g, "_");
      const filename = `${uploader}_${safeOriginal}`;
      const uploaded = await uploadFileToDrive(drive, f.path, filename, typeFolderId);
      links.push(uploaded.webViewLink || "");
      try { fs.unlinkSync(f.path); } catch (e) {}
    }

    if (SPREADSHEET_ID) {
      const sheets = getSheetsClient();
      const now = new Date().toISOString();
      const linksCell = links.filter(Boolean).join("\n");
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, workType, address, uploader, memo, linksCell, now]] },
      });
    }

    return res.json({ success: true, message: "uploaded", links });
  } catch (err) {
    console.error("🔥 upload error:", err?.message || err);
    if (err?.response?.data) console.error("🔥 response.data:", err.response.data);

    return res.status(500).json({
      success: false,
      message: "upload failed",
      error: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on", PORT));
