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

// ===============================
// ✅ 기본 설정
// ===============================
const PORT = process.env.PORT || 10000;
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

// ✅ 스프레드시트
const SHEET_ID = "1U9ZnKg8j7WmR8HYlMhN55fWjPBXVogyyzVQDiS3PkkY";
const SHEET_NAME = "시트1"; // 탭 이름

// ✅ 업로드 임시 저장 (Render 디스크는 영구저장 아님 → 업로드 후 삭제)
const upload = multer({ dest: "uploads/" });

// ✅ (중요) 업로드할 "공사사진" 폴더 ID
// 네가 보여준 링크가 이 폴더라면 그대로 사용
const ROOT_FOLDER_ID = "0AGi8kzl6STpwUk9PVA"; 
// ↑ 이게 "공유 드라이브 ID"일 수도 있고 "폴더 ID"일 수도 있어서
// 아래에서 자동으로 안전하게 처리함

// ===============================
// ✅ Google API Client
// ===============================
function getGoogleClients() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing env GOOGLE_SERVICE_ACCOUNT_JSON");

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON string");
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });

  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  return { drive, sheets };
}

// ===============================
// ✅ 폴더 찾기/생성 유틸 (공유드라이브/내드라이브 모두 대응)
// ===============================
async function getOrCreateFolder(drive, folderName, parentId) {
  // parentId 아래에 folderName 폴더가 있는지 검색
  const safeName = String(folderName).replace(/'/g, "\\'");

  const q = [
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
    `'${parentId}' in parents`,
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
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return createRes.data.id;
}

// ===============================
// ✅ 시트에 한줄 추가
// A: workDate
// B: workType
// C: address
// D: uploader
// E: 계약명(빈칸)
// F: 대표사진 링크
// ===============================
async function appendToSheet(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ===============================
// ✅ 업로드 API
// ===============================
app.post("/upload", upload.array("photos"), async (req, res) => {
  try {
    const { workDate, workType, address, uploader } = req.body;

    if (!workDate || !workType || !uploader) {
      return res.status(400).json({
        success: false,
        message: "workDate/workType/uploader required",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "no files" });
    }

    const { drive, sheets } = getGoogleClients();

    // 1) 날짜 폴더 생성 (공사사진 폴더 아래)
    const dateFolderId = await getOrCreateFolder(drive, workDate, ROOT_FOLDER_ID);

    // 2) 공종 폴더 생성 (날짜 폴더 아래)
    const typeFolderId = await getOrCreateFolder(drive, workType, dateFolderId);

    // 3) 파일 업로드
    const uploadedLinks = [];

    for (const file of req.files) {
      const safeUploader = String(uploader).replace(/\s+/g, "");
      const ext = path.extname(file.originalname) || "";
      const fileName = `${workDate.replace(/-/g, "")}_${workType}_${safeUploader}_${Date.now()}${ext}`;

      const fileRes = await drive.files.create({
        supportsAllDrives: true,
        requestBody: {
          name: fileName,
          parents: [typeFolderId],
        },
        media: {
          mimeType: file.mimetype,
          body: fs.createReadStream(file.path),
        },
        fields: "id, webViewLink",
      });

      uploadedLinks.push(fileRes.data.webViewLink);

      // 임시 파일 삭제
      try {
        fs.unlinkSync(file.path);
      } catch (_) {}
    }

    // 대표 링크 = 첫번째 사진
    const 대표링크 = uploadedLinks[0] || "";
    const 계약명 = ""; // 웹에는 없으니 빈칸 저장

    // 4) 시트 기록
    await appendToSheet(sheets, [
      workDate,
      workType,
      address || "",
      uploader,
      계약명,
      대표링크,
    ]);

    return res.json({
      success: true,
      link: 대표링크,
      links: uploadedLinks,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ success: false, message: "upload failed" });
  }
});

app.listen(PORT, () => {
  console.log("서버 실행중:", PORT);
  console.log("BASE_URL:", BASE_URL);
});
