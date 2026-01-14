/**
 * server.js
 * Render + Google Shared Drive 업로드 (Secret File 방식 + 업로드 500 방지 최종본)
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

// =============================
// 설정값
// =============================
const PORT = process.env.PORT || 10000;
const SHARED_DRIVE_ID = "0AGi8kzl6STpwUk9PVA";
const TOP_FOLDER_NAME = "공사사진";

// =============================
// ✅ Render에서 uploads 폴더가 없어서 Multer가 500 터지는 문제 방지
// =============================
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer (필드명 상관없이 받기: upload.any())
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (필요하면 조절)
});

// =============================
// 서비스계정 로딩 (Secret File 우선)
// =============================
function getServiceAccountFromEnv() {
  // 1) Secret File 방식 우선
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (filePath && fs.existsSync(filePath)) {
    const rawFile = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(rawFile);
  }

  // 2) (백업) ENV JSON 문자열 방식
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  // Render에서 \\n 형태로 들어왔을 때 복원
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
  const safeName = String(name).replace(/'/g, "\\'");

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

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: String(name),
      mimeType: "application/vnd.google-apps.folder",
      // Shared Drive 최상위는 부모를 driveId로 둬도 동작하는 경우가 많음 (너 환경에서 이미 list가 되는 상태)
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
app.post("/upload", upload.any(), async (req, res) => {
  // ✅ Multer는 fieldname이 달라도 files[]로 들어오게 처리
  const file = (req.files && req.files[0]) || req.file;

  // ✅ 프론트에서 키 이름이 달라도 받게 방어
  const date =
    req.body.date ||
    req.body.workDate ||
    req.body.selectedDate ||
    req.body.work_date;

  const workType =
    req.body.workType ||
    req.body.work_type ||
    req.body.category ||
    req.body.work ||
    req.body.type;

  try {
    if (!file) {
      return res.status(400).json({ success: false, message: "no file" });
    }
    if (!date || !workType) {
      // 임시파일 삭제
      try {
        if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch (_) {}
      return res.status(400).json({ success: false, message: "missing date/workType" });
    }

    // 1) 공사사진
    const rootId = await getOrCreateFolder(TOP_FOLDER_NAME);

    // 2) 날짜 폴더
    const dateId = await getOrCreateFolder(String(date), rootId);

    // 3) 공종 폴더
    const workId = await getOrCreateFolder(String(workType), dateId);

    // 4) 파일 업로드
    const uploaded = await drive.files.create({
      requestBody: {
        name: file.originalname || path.basename(file.path) || "upload.jpg",
        parents: [workId],
      },
      media: {
        mimeType: file.mimetype || "application/octet-stream",
        body: fs.createReadStream(file.path),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    // 임시파일 삭제
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}

    res.json({
      success: true,
      fileId: uploaded.data.id,
      link: uploaded.data.webViewLink,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    // 임시파일 삭제
    try {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}

    res.status(500).json({
      success: false,
      message: "upload failed",
      error: String(err && err.message ? err.message : err),
    });
  }
});

// =============================
// ✅ Multer/기타 에러를 JSON으로 고정 (HTML 500 방지)
// =============================
app.use((err, req, res, next) => {
  console.error("MIDDLEWARE ERROR:", err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, message: "multer error", error: err.message });
  }
  return res.status(500).json({ success: false, message: "server error", error: err.message || String(err) });
});

// =============================
// 서버 시작
// =============================
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
