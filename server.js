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

// ---------- 기본 설정 ----------
const PORT = process.env.PORT || 10000;

// ✅ 공유드라이브 ID (지금 너 URL에 보이는 그거)
const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID || "0AGi8kzl6STpwUk9PVA";

// ✅ Render Secret Files로 넣었으면 이 경로로 읽힘
// Environment Variables에 GOOGLE_SERVICE_ACCOUNT_FILE=/etc/secrets/credentials.json 로 세팅된 상태면 자동 사용
const SERVICE_ACCOUNT_FILE =
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "/etc/secrets/credentials.json";

// 업로드 임시 저장 폴더(Render 디스크 영구 아님 → 업로드 후 삭제)
const upload = multer({ dest: "uploads/" });

// ---------- 서비스계정 로드 ----------
function getServiceAccount() {
  // 1) JSON 문자열 환경변수
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  }

  // 2) Secret File 경로(기본 /etc/secrets/credentials.json)
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    const raw = fs.readFileSync(SERVICE_ACCOUNT_FILE, "utf8");
    return JSON.parse(raw);
  }

  // 3) 로컬 fallback
  const localPath = path.join(__dirname, "credentials.json");
  if (fs.existsSync(localPath)) {
    const raw = fs.readFileSync(localPath, "utf8");
    return JSON.parse(raw);
  }

  throw new Error(
    "Missing service account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE (/etc/secrets/credentials.json)."
  );
}

const serviceAccount = getServiceAccount();

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

// ---------- 유틸: 폴더 생성/조회 (공유드라이브 루트 기준) ----------
async function getOrCreateFolder(name, parentId) {
  const parent = parentId || SHARED_DRIVE_ID;

  // ✅ 핵심: "공유드라이브 driveId/corpora"로 꼬지 말고,
  // 부모폴더 기준으로 찾는다. (공유드라이브든 내드라이브든 상관없이 안전)
  const q = [
    `'${parent}' in parents`,
    `name='${name.replace(/'/g, "\\'")}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ].join(" and ");

  const listRes = await drive.files.list({
    q,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (listRes.data.files && listRes.data.files.length > 0) {
    return listRes.data.files[0].id;
  }

  const createRes = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parent],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return createRes.data.id;
}

// ---------- 정적 페이지(사이트) ----------
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  // public/index.html 있으면 그걸 보여줌
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- 업로드 API ----------
app.post("/upload", upload.any(), async (req, res) => {
  try {
    // ✅ multer 필드명 꼬여도 무조건 받게 처리
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: "No file received (check <input type='file' ...>)",
      });
    }

    const file = files[0]; // 지금은 1장 기준
    const { date, workType, address, uploader } = req.body;

    if (!date || !workType || !address || !uploader) {
      // 업로드 된 파일은 지우고 종료
      try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({
        success: false,
        message: "upload failed",
        error: "Missing fields: date/workType/address/uploader",
      });
    }

    // 1) 날짜 폴더(YYYY-MM-DD) → 공종 폴더 생성
    const dateFolderId = await getOrCreateFolder(date);
    const typeFolderId = await getOrCreateFolder(workType, dateFolderId);

    // 2) 파일 업로드
    const ext = path.extname(file.originalname || "") || ".jpg";
    const safeUploader = String(uploader).replace(/[\\/:*?"<>|]/g, "_");
    const safeWorkType = String(workType).replace(/[\\/:*?"<>|]/g, "_");
    const filename = `${date}_${safeWorkType}_${safeUploader}_${Date.now()}${ext}`;

    const uploadRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [typeFolderId],
      },
      media: {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    // 3) 임시파일 삭제
    try { fs.unlinkSync(file.path); } catch {}

    return res.json({
      success: true,
      message: "uploaded",
      fileId: uploadRes.data.id,
      link: uploadRes.data.webViewLink,
      savedToDriveRoot: SHARED_DRIVE_ID,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    return res.status(500).json({
      success: false,
      message: "upload failed",
      error: err?.message || String(err),
    });
  }
});

// ---------- 서버 시작 ----------
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
