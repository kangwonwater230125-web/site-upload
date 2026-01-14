/**
 * server.js
 * Render + Google Shared Drive 업로드 (Secret File 방식 최종본)
 */

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

// Render 임시 업로드 폴더
const upload = multer({ dest: "uploads/" });

// =============================
// 설정값
// =============================
const PORT = process.env.PORT || 10000;
const SHARED_DRIVE_ID = "0AGi8kzl6STpwUk9PVA";
const TOP_FOLDER_NAME = "공사사진";

// =============================
// 서비스계정 로딩 (Secret File 우선)
// =============================
function getServiceAccountFromEnv() {
  // 1️⃣ Secret File 방식
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (filePath && fs.existsSync(filePath)) {
    const rawFile = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(rawFile);
  }

  // 2️⃣ (백업) ENV JSON 문자열 방식
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON"
    );
  }

  const fixed = raw.replace(/\\n/g, "\n");
  return JSON.parse(fixed);
}

// =============================
// Google Drive Auth
// =============================
const serviceAccount = getServiceAccountFromEnv();

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

// =============================
// Shared Drive 폴더 생성/검색
// =============================
async function getOrCreateFolder(name, parentId = null) {
  const safeName = name.replace(/'/g, "\\'");

  const q = [
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    parentId ? `'${parentId}' in parents` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [SHARED_DRIVE_ID],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

// =============================
// 헬스체크
// =============================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// =============================
// 정적 페이지
// =============================
app.use(express.static(path.join(__dirname, "public")));

// =============================
// 업로드 API
// =============================
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    const { date, workType } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, message: "no file" });
    }

    if (!date || !workType) {
      fs.unlinkSync(file.path);
      return res
        .status(400)
        .json({ success: false, message: "missing date/workType" });
    }

    // 1) 공사사진
    const rootId = await getOrCreateFolder(TOP_FOLDER_NAME);

    // 2) 날짜
    const dateId = await getOrCreateFolder(date, rootId);

    // 3) 공종
    const workId = await getOrCreateFolder(workType, dateId);

    // 4) 파일 업로드
    const uploaded = await drive.files.create({
      requestBody: {
        name: file.originalname,
        parents: [workId],
      },
      media: {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    fs.unlinkSync(file.path);

    res.json({
      success: true,
      fileId: uploaded.data.id,
      link: uploaded.data.webViewLink,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (_) {}

    res.status(500).json({ success: false, message: "upload failed" });
  }
});

// =============================
// 서버 시작
// =============================
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
