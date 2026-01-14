const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());

// ✅ JSON / urlencoded도 받기 (프론트가 JSON으로 보내도 대응)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ multer (multipart/form-data 대응)
const upload = multer({ dest: "uploads/" });

// ✅ Render env
const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID || "0AGi8kzl6STpwUk9PVA";

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

// (선택) 시트 기록용 - 없으면 자동 스킵
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

// ✅ 폴더 찾기/생성
async function findOrCreateFolder(drive, name, parentId) {
  const escaped = name.replace(/'/g, "\\'");
  const q = [
    `name='${escaped}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    "trashed=false",
    parentId ? `'${parentId}' in parents` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });

  if (list.data.files && list.data.files.length > 0) return list.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
      driveId: SHARED_DRIVE_ID,
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
      driveId: SHARED_DRIVE_ID,
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

app.get("/", (req, res) => res.send("OK"));

// ✅ 공통: body에서 필드 뽑기 (키 이름 다 달라도 흡수)
function extractFields(body) {
  const date = body.date || body.workDate || body.work_date || "";
  const workType = body.workType || body.work_type || body.type || "";
  const address = body.address || body.addr || body.location || "";
  const uploader = body.uploader || body.uploaderName || body.name || "";
  const memo = body.memo || body.note || "";
  return { date, workType, address, uploader, memo };
}

// ✅ 1) multipart/form-data 업로드 (파일 포함)
// 여기서 "photos" / "photo" / "file" 어떤 이름으로 와도 받게 3개 다 허용
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
    console.log("=== /upload hit (multipart or form) ===");
    console.log("content-type:", req.headers["content-type"]);
    console.log("req.body:", req.body);
    console.log(
      "files:",
      (req.files || []).map((f) => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        size: f.size,
      }))
    );

    const { date, workType, address, uploader, memo } = extractFields(req.body);

    const missing = [];
    if (!date) missing.push("date");
    if (!workType) missing.push("workType");
    if (!address) missing.push("address");
    if (!uploader) missing.push("uploader");

    if (missing.length > 0) {
      console.log("❌ Missing fields:", missing);
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: `Missing fields: ${missing.join("/")}`,
      });
    }

    if (!req.files || req.files.length === 0) {
      console.log("❌ No files uploaded");
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: "No files uploaded",
      });
    }

    const drive = getDriveClient();

    const rootFolderId = await findOrCreateFolder(drive, "공사사진", null);
    const dateFolderId = await findOrCreateFolder(drive, date, rootFolderId);
    const typeFolderId = await findOrCreateFolder(drive, workType, dateFolderId);

    const links = [];
    for (const f of req.files) {
      const safeOriginal = f.originalname.replace(/[\\/:*?"<>|]/g, "_");
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
        requestBody: {
          values: [[date, workType, address, uploader, memo, linksCell, now]],
        },
      });
    } else {
      console.log("⚠️ SPREADSHEET_ID not set → skip sheet append");
    }

    return res.json({ success: true, message: "uploaded", links });
  } catch (err) {
    console.error("🔥 upload error:", err);
    return res.status(500).json({
      success: false,
      message: "upload failed",
      error: err.message || String(err),
    });
  }
});

// ✅ 2) JSON 업로드 (파일 없이) — 프론트가 JSON으로 보내는지 확인용
app.post("/upload-json", async (req, res) => {
  console.log("=== /upload-json hit ===");
  console.log("content-type:", req.headers["content-type"]);
  console.log("req.body:", req.body);

  const { date, workType, address, uploader } = extractFields(req.body || {});
  const missing = [];
  if (!date) missing.push("date");
  if (!workType) missing.push("workType");
  if (!address) missing.push("address");
  if (!uploader) missing.push("uploader");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: "json upload failed",
      error: `Missing fields: ${missing.join("/")}`,
    });
  }
  return res.json({ success: true, message: "json received" });
});

app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on", PORT));
