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

// ✅ 한글 파일명 깨짐 복구 (latin1로 들어온 UTF-8을 되살림)
function fixMulterFilename(name) {
  if (!name) return "";
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (fixed.includes(" ")) return name;
    return fixed;
  } catch {
    return name;
  }
}

function sanitizeFilename(name) {
  return (name || "")
    .replace(/\u0000/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// ✅ 확장자 결정: 원본명 > mimetype
function getExt(file) {
  const orig = file?.originalname || "";
  const m = orig.match(/\.([a-zA-Z0-9]+)$/);
  if (m && m[1]) return m[1].toLowerCase();

  const mt = (file?.mimetype || "").toLowerCase();
  if (mt.includes("jpeg")) return "jpg";
  if (mt.includes("png")) return "png";
  if (mt.includes("gif")) return "gif";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("heic")) return "heic";
  return "bin";
}

// ✅ 모바일에서 흔한 “의미없는 파일명” 판별
function isGenericOriginalName(name) {
  if (!name) return true;
  const base = name.replace(/\.[^.]+$/, "").toLowerCase().trim();

  // 흔한 기본값들
  const bad = ["image", "photo", "camera", "file", "blob", "capture"];
  if (bad.includes(base)) return true;

  // 숫자만 (예: 6962)
  if (/^\d{1,10}$/.test(base)) return true;

  // 짧고 의미 없음
  if (base.length <= 3) return true;

  return false;
}

// ✅ 통일 파일명 생성: 업로더_날짜_공종_HHMMSS_순번.ext
function makeNiceFilename({ uploader, date, workType, index, file }) {
  const ext = getExt(file);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const seq = String(index + 1).padStart(2, "0");

  const safeUploader = sanitizeFilename(uploader) || "업로더";
  const safeDate = sanitizeFilename(date) || "날짜";
  const safeType = sanitizeFilename(workType) || "공종";

  return sanitizeFilename(`${safeUploader}_${safeDate}_${safeType}_${hh}${mm}${ss}_${seq}.${ext}`);
}

// ✅ “부모 폴더 안에서” 폴더 찾기/생성
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

async function uploadFileToDrive(drive, localPath, filename, parentId, mimeType) {
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType: mimeType || "application/octet-stream", body: fs.createReadStream(localPath) },
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
    if (!DRIVE_ROOT_FOLDER_ID) {
      return res.status(500).json({ success: false, message: "upload failed", error: "Missing env DRIVE_ROOT_FOLDER_ID" });
    }

    const { date, workType, address, uploader, memo } = extractFields(req.body);

    const missing = [];
    if (!date) missing.push("date");
    if (!workType) missing.push("workType");
    if (!address) missing.push("address");
    if (!uploader) missing.push("uploader");

    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: "upload failed", error: `Missing fields: ${missing.join("/")}` });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "upload failed", error: "No files uploaded" });
    }

    const drive = getDriveClient();

    // ✅ 공유드라이브 루트 폴더 아래에 공사사진/날짜/공종
    const rootFolderId = await findOrCreateFolder(drive, "공사사진", DRIVE_ROOT_FOLDER_ID);
    const dateFolderId = await findOrCreateFolder(drive, date, rootFolderId);
    const typeFolderId = await findOrCreateFolder(drive, workType, dateFolderId);

    const links = [];
    const originalNames = [];

    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];

      // 원본명(복구) 저장용
      const recovered = sanitizeFilename(fixMulterFilename(f.originalname || ""));
      originalNames.push(recovered || "");

      // ✅ 실제 업로드 파일명: 통일 규칙
      // (원하면: recovered가 의미있을 때는 recovered도 섞을 수 있는데, 일단 100% 통일이 깔끔함)
      const filename = makeNiceFilename({ uploader, date, workType, index: i, file: f });

      const uploaded = await uploadFileToDrive(drive, f.path, filename, typeFolderId, f.mimetype);
      links.push(uploaded.webViewLink || "");

      try { fs.unlinkSync(f.path); } catch {}
    }

    // 시트 기록(있을 때만)
    if (SPREADSHEET_ID) {
      const sheets = getSheetsClient();
      const now = new Date().toISOString();
      const linksCell = links.filter(Boolean).join("\n");
      const origCell = originalNames.filter(Boolean).join("\n"); // 원본명도 남기고 싶으면

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[date, workType, address, uploader, memo, linksCell, origCell, now]] },
      });
    }

    return res.json({ success: true, message: "uploaded", links });
  } catch (err) {
    console.error("🔥 upload error:", err?.message || err);
    if (err?.response?.data) console.error("🔥 response.data:", err.response.data);

    return res.status(500).json({ success: false, message: "upload failed", error: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on", PORT));
