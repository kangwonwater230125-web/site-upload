const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { google } = require('googleapis');


const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());
app.use('/files', express.static(path.join(__dirname, 'uploads')));
// 🔹 index.html을 루트(/)에서 보여주기
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { workDate, workType } = req.body;

    const baseDir = path.join(__dirname, 'uploads');
    const dateDir = path.join(baseDir, workDate);
    const typeDir = path.join(dateDir, workType);

    if (!fs.existsSync(typeDir)) {
      fs.mkdirSync(typeDir, { recursive: true });
    }

    cb(null, typeDir);
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

app.post('/upload', upload.array('photos'), async (req, res) => {
  try {
    const { workDate, workType, address, uploader } = req.body;

    // 대표사진 링크(첫 번째 파일 1개)
    let 대표링크 = '';
    if (req.files && req.files.length > 0) {
      const relPath = path
        .relative(path.join(__dirname, 'uploads'), req.files[0].path)
        .split(path.sep)
        .join('/');

      대표링크 = `http://localhost:3000/files/${relPath}`;
    }

    const 계약명 = ''; // 웹에는 없으니 빈칸 저장 (나중에 직접 입력)

    // 시트에 한 줄 추가
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
    console.error('시트 기록 실패:', err);
    res.status(500).json({ success: false, message: 'sheet append failed' });
  }
});
const SHEET_ID = '1U9ZnKg8j7WmR8HYlMhN55fWjPBXVogyyzVQDiS3PkkY';
const SHEET_NAME = '시트1'; // ← 시트 탭 이름(대부분 시트1)

async function appendToSheet(row) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
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

app.listen(3000, () => {
  console.log('서버 실행중 : http://localhost:3000');
});
