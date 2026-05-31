const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { exec, execSync } = require("child_process");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// FFmpeg — Railway provides it via nixpacks.toml
function getFFmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    return execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0];
  } catch (_) { return "ffmpeg"; }
}
const FFMPEG = getFFmpegPath();

const UPLOADS_DIR = path.join("/tmp", "uploads");
const OUTPUTS_DIR = path.join("/tmp", "outputs");
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUTS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    /\.(mov|mp4|avi|mkv|wmv|flv|webm|m4v|mts|m2ts)$/i.test(file.originalname)
      ? cb(null, true) : cb(new Error(`Unsupported: ${file.originalname}`));
  },
});

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(`"${FFMPEG}" -i "${filePath}" 2>&1`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const m = (stdout + stderr).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return reject(new Error("Could not read video duration"));
      resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

function extractFrames(inputPath, outputDir, fps) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const out = path.join(outputDir, "output_%05d.jpg");
    exec(`"${FFMPEG}" -i "${inputPath}" -vf "fps=${fps}" -q:v 2 "${out}" -y`,
      { maxBuffer: 50 * 1024 * 1024 }, (err, _, stderr) => {
        const files = fs.existsSync(outputDir)
          ? fs.readdirSync(outputDir).filter(f => f.endsWith(".jpg")) : [];
        if (err && files.length === 0) return reject(new Error(stderr || err.message));
        resolve(outputDir);
      });
  });
}

function zipFolder(sourceDir, destPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function cleanup(p) {
  try {
    if (!fs.existsSync(p)) return;
    fs.statSync(p).isDirectory()
      ? fs.rmSync(p, { recursive: true, force: true }) : fs.unlinkSync(p);
  } catch (_) {}
}

const jobs = new Map();

app.get("/api/status", (req, res) => {
  exec(`"${FFMPEG}" -version`, (err, stdout) => {
    if (err) return res.json({ ok: false, message: "FFmpeg not found on server." });
    const version = (stdout.match(/ffmpeg version (\S+)/) || [])[1] || "unknown";
    res.json({ ok: true, version });
  });
});

app.post("/api/process", upload.array("videos"), async (req, res) => {
  const files = req.files;
  const desiredFrames = parseInt(req.body.frames);
  if (!files?.length) return res.status(400).json({ error: "No videos uploaded." });
  if (!desiredFrames || desiredFrames < 1 || desiredFrames > 10000)
    return res.status(400).json({ error: "Frame count must be 1–10000." });

  const jobId = uuidv4();
  jobs.set(jobId, { status: "running", total: files.length, done: 0, results: [], errors: [] });
  res.json({ jobId });

  (async () => {
    for (const file of files) {
      const job = jobs.get(jobId);
      const safeBase = path.parse(file.originalname).name.replace(/[^a-zA-Z0-9_\-]/g, "_");
      try {
        const duration = await getVideoDuration(file.path);
        if (duration <= 0) throw new Error("Invalid video duration.");
        const fps = Math.min(desiredFrames / duration, 60);
        const frameDir = path.join(OUTPUTS_DIR, `${jobId}_${safeBase}`);
        await extractFrames(file.path, frameDir, fps.toFixed(6));
        const extracted = fs.readdirSync(frameDir).filter(f => f.endsWith(".jpg")).length;
        const zipPath = path.join(OUTPUTS_DIR, `${jobId}_${safeBase}.zip`);
        await zipFolder(frameDir, zipPath);
        cleanup(frameDir);
        job.results.push({
          originalName: file.originalname, safeBase,
          zipPath: `/outputs/${jobId}_${safeBase}.zip`,
          duration: duration.toFixed(2), fps: fps.toFixed(4), extracted,
        });
      } catch (err) {
        job.errors.push({ originalName: file.originalname, error: err.message });
      } finally {
        cleanup(file.path);
        job.done++;
      }
    }
    jobs.get(jobId).status = "done";
  })();
});

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

app.post("/api/rename", (req, res) => {
  const { oldPath, newName } = req.body;
  if (!oldPath || !newName) return res.status(400).json({ error: "Missing params." });
  const finalName = (newName.replace(/[^a-zA-Z0-9_\-. ]/g, "_").trim() + (newName.endsWith(".zip") ? "" : ".zip"));
  const absOld = path.join("/tmp", oldPath);
  const absNew = path.join(OUTPUTS_DIR, finalName);
  if (!fs.existsSync(absOld)) return res.status(404).json({ error: "File not found." });
  try {
    fs.renameSync(absOld, absNew);
    res.json({ newPath: `/outputs/${finalName}`, newName: finalName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cleanup files older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    [UPLOADS_DIR, OUTPUTS_DIR].forEach(dir =>
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) cleanup(p);
      })
    );
  } catch (_) {}
}, 15 * 60 * 1000);

app.listen(PORT, () => console.log(`FrameForge running on port ${PORT} | FFmpeg: ${FFMPEG}`));
