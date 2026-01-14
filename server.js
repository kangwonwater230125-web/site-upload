const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

// 정적 파일 (로고 등)
app.use(express.static(path.join(__dirname, 'public')));

// 루트(/)에서 index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* =========================
   multer (임시 업로드용)
   ========================= */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const uploader = req.body.uploader.replace(/\s+/g, '');
    const workDate = req.body.workDate.replace(/-/g, '');
    const ext = file.originalname.split('.').pop();
    const safeName = `${workDate}_${req.body.workType}_${uploader}_${Date.now()}.${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({ storage });

/* =========================
   Google Drive 업로드 함수
   ========================= */
async function uploadToDrive(filePath, fileName, workDate, workType) {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/etc/secrets/credentials.json',
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets'
    ],
  });

  const drive = google.drive({ version: 'v3', auth });

  // 1. 최상위 "공사사진" 폴더
  const rootRes = await drive.files.list({
    q: "name='공사사진' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id)',
  });

  if (!rootRes.data.files.length) {
    throw new Error('Google Drive에 "공사사진" 폴더가 없습니다 (공유 확인)');
  }

  const rootId = rootRes.data.files[0].id;

  // 2. 날짜 폴더
  const dateRes = await drive.files.list({
    q: `'${rootId}' in parents and name='${workDate}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });

  const dateId = dateRes.data.files.length
    ? dateRes.data.files[0].id
    : (await drive.files.create({
        requestBody: {
          name: workDate,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootId],
        },
      })).data.id;

  // 3. 공종 폴더
  const typeRes = await drive.files.list({
    q: `'${dateId}' in parents and name='${workType}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });

  const typeId = typeRes.data.files.length
    ? typeRes.data.files[0].id
    : (await drive.files.create({
        requestBody: {
          name: workType,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [dateId],
        },
      })).data.id;

  // 4. 파일 업로드
  const fileRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [typeId],
    },
    media: {
      body: fs.createReadStream(filePath),
    },
    fields: 'webViewLink',
  });

  return fileRes.data.webViewLink;
}

/* =========================
   Google Sheet 설정
   ========================= */
const SHEET_ID = '1U9ZnKg8j7WmR8HYlMhN55fWjPBXVogyyzVQDiS3PkkY';
const SHEET_NAME = '시트1';

async function appendToSheet(row) {
  const auth = new google.auth.GoogleAuth({
    keyFile: '/etc/secrets/credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

/* =========================
   업로드 API
   ========================= */
app.post('/upload', upload.array('photos'), async (req, res) => {
  try {
    const { workDate, workType, address, uploader } = req.body;

    let 대표링크 = '';
    if (req.files && req.files.length > 0) {
      대표링크 = await uploadToDrive(
        req.files[0].path,
        req.files[0].filename,
        workDate,
        workType
      );
    }

    const 계약명 = '';

    await appendToSheet([
      workDate,
      workType,
      address || '',
      uploader,
      계약명,
      대표링크
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('업로드 실패:', err);
    res.status(500).json({ success: false, message: 'upload failed' });
  }
});

/* =========================
   서버 시작
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행중 : ${PORT}`);
});
