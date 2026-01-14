/**
 * server.js (Render + Google Shared Drive 업로드용 / 전체 복붙용)
 * - Shared Drive(공유드라이브)에서 폴더 생성/검색을 올바르게 처리
 * - 업로드 후 임시파일 삭제
 * - (선택) 스프레드시트 기록은 기존에 네가 쓰던 부분이 있으면 거기에 붙이면 됨
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

// Render는 디스크 영구 저장 아님 → 업로드 후 바로 삭제
const upload = multer({ dest: "uploads/" });

// ✅ 공유 드라이브 ID
const SHARED_DRIVE_ID = "0AGi8kzl6STpwUk9PVA";

// ✅ 최상위 폴더명(공유드라이브 루트에 이 폴더 생성/사용)
const TOP_FOLDER_NAME = "공사사진";

// ✅ 서비스계정 JSON (Render Env: GOOGLE_SERVICE_ACCOUNT_JSON)
function getServiceAccountFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing env GOOGLE_SERVICE_ACCOUNT_JSON");

  // Render에 JSON을 문자열로 저장하면 \n 형태로 들어갈 수 있어 복원
  // (이미 정상 JSON이면 그대로 parse 됨)
  const fixed = raw.replace(/\\n/g, "\n");
  return JSON.parse(fixed);
}

const sa = getServiceAccountFromEnv();

const auth = new google.auth.GoogleAuth({
  credentials: sa,
  scopes: [
    "https://www.googleapis.com/auth/drive",
    // 스프레드시트까지 쓰면 아래 scope도 필요
    // "https://www.googleapis.com/auth/spreadsheets",
  ],
});

const drive = google.drive({ version: "v3", auth });

// ✅ Shared Drive에서 폴더를 안전하게 찾거나 생성
// 핵심: Shared Drive ID를 'parents'로 검색하지 않고,
// corpora:'drive' + driveId로 "범위"를 고정한 뒤 폴더를 찾는다.
async function getOrCreateFolder(folderName, parentId = null) {
  const safeName = folderName.replace(/'/g, "\\'");

  const qParts = [
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ];

  // parentId가 있을 때만 parents 조건을 건다.
  if (parentId) qParts.push(`'${parentId}' in parents`);

  const res = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: SHARED_DRIVE_ID,
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // 없으면 생성
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      // parentId가 없으면 shared drive 루트에 생성
      parents: parentId ? [parentId] : [SHARED_DRIVE_ID],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

// ✅ 헬스체크
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ✅ 프론트 정적 파일(있으면)
app.use(express.static(path.join(__dirname, "public")));

// ✅ 업로드 API
// form-data:
// - date: YYYY-MM-DD
// - workType: 공종
// - address: 주소(옵션)
// - uploader: 업로더(옵션)
// - photo: 파일
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    const { date, workType, address, uploader } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, message: "no file" });
    }
    if (!date || !workType) {
      // date/workType 필수
      fs.unlinkSync(file.path);
      return res
        .status(400)
        .json({ success: false, message: "missing date/workType" });
    }

    // 1) 공유드라이브 루트 밑에 "공사사진"
    const topFolderId = await getOrCreateFolder(TOP_FOLDER_NAME);

    // 2) 날짜 폴더
    const dateFolderId = await getOrCreateFolder(date, topFolderId);

    // 3) 공종 폴더
    const workFolderId = await getOrCreateFolder(workType, dateFolderId);

    // 파일명 충돌 방지(원하면 시간 붙이기)
    const safeOriginal = file.originalname || "photo";
    const finalName = safeOriginal;

    // 4) Drive 업로드
    const driveRes = await drive.files.create({
      requestBody: {
        name: finalName,
        parents: [workFolderId],
      },
      media: {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    // 5) 임시파일 삭제
    fs.unlinkSync(file.path);

    // (선택) 여기서 스프레드시트 기록 로직 붙이면 됨
    // date, workType, address, uploader, driveRes.data.webViewLink 등 사용

    return res.json({
      success: true,
      message: "uploaded",
      fileId: driveRes.data.id,
      link: driveRes.data.webViewLink,
      meta: { date, workType, address: address || "", uploader: uploader || "" },
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    // multer 임시파일 남아있으면 지우기(에러 시도)
    try {
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (_) {}

    return res.status(500).json({ success: false, message: "upload failed" });
  }
});

// ✅ Render 포트 바인딩
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
