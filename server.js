const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// প্রোডাকশন (Extra Resources) ও ডেভেলপমেন্টের জন্য ডাইনামিক পাথ
const isPackaged = __dirname.includes('app.asar');
const basePath = isPackaged ? process.resourcesPath : __dirname;

// অটোমেটিক OS ডিটেকশন (ম্যাক নাকি উইন্ডোজ) - এটি আপনার কোডে মিসিং ছিল
const isWin = process.platform === 'win32';
const osFolder = isWin ? 'win' : 'mac';
const ytDlpExt = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ffmpegExt = isWin ? 'ffmpeg.exe' : 'ffmpeg';

const ytDlpPath = path.join(basePath, 'binaries', osFolder, ytDlpExt);
const ffmpegPath = path.join(basePath, 'binaries', osFolder, ffmpegExt);

// ডিরেক্টরি পাথ সঠিক করা (macOS ও Windows এর জন্য)
const resolveHomeDir = (dirPath) => {
    if (!dirPath) return path.join(process.env.HOME || process.env.USERPROFILE, 'Downloads');
    if (dirPath.startsWith('~')) {
        return path.join(process.env.HOME || process.env.USERPROFILE, dirPath.slice(1));
    }
    return dirPath;
};

// নোড মেথড দিয়ে ফাইল সেভ করা
const downloadFileNative = (fileUrl, destPath, callback) => {
    const client = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    client.get(fileUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
            return downloadFileNative(response.headers.location, destPath, callback);
        }
        if (response.statusCode !== 200) {
            file.close();
            fs.unlink(destPath, () => {});
            return callback(new Error(`Server returned status code ${response.statusCode}`));
        }

        response.pipe(file);
        file.on('finish', () => {
            file.close(callback);
        });
    }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        callback(err);
    });
};

// ১. ভিডিও প্রিভিউ ও টাইটেল ফেচ করা
app.post('/api/info', (req, res) => {
    let { url, useCookies } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
    }

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        url = url.split('&list=')[0].split('&index=')[0];
    }

    let cookieFlag = useCookies ? '--cookies-from-browser chrome' : '';
    
    // সিস্টেমের বদলে লোকাল yt-dlp ব্যবহার
    const command = `"${ytDlpPath}" ${cookieFlag} --no-playlist --get-title --get-url -f "b/best[ext=mp4]/best" "${url}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
            console.error('\n❌ YT-DLP ERROR LOG:', stderr || error.message);
            return res.status(500).json({ success: false, error: 'Failed to fetch video preview.' });
        }

        const lines = stdout.trim().split('\n');
        const title = lines[0];
        const streamUrl = lines[lines.length - 1];

        res.json({ success: true, title, streamUrl });
    });
});

// ২. স্ট্রিমিং ডাউনলোড (macOS QuickTime & H.264 Playable MP4 Fix)
app.get('/api/download-stream', (req, res) => {
    let { 
        url, quality, useCookies, resolution, startTime, 
        endTime, downloadSub, downloadThumb, convertGif, cropShorts, saveLocation,
        downloadMainMedia
    } = req.query;

    if (!url) return res.status(400).send('URL is required');

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        url = url.split('&list=')[0].split('&index=')[0];
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let baseDir = resolveHomeDir(saveLocation);

    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    let selectedCount = 0;
    if (downloadMainMedia === 'true') selectedCount++;
    if (downloadThumb === 'true') selectedCount++;
    if (downloadSub === 'true') selectedCount++;
    if (convertGif === 'true') selectedCount++;

    const isMultiple = selectedCount > 1;
    let outputTemplate = isMultiple ? '%(title)s/%(title)s.%(ext)s' : '%(title)s.%(ext)s';

    // ১টি থাম্বনেইল আলাদা নামানোর বিশেষ লজিক
    if (downloadMainMedia === 'false' && downloadThumb === 'true' && selectedCount === 1) {
        let cookieFlag = useCookies === 'true' ? '--cookies-from-browser chrome' : '';
        const getThumbCmd = `"${ytDlpPath}" ${cookieFlag} --no-playlist --get-thumbnail "${url}"`;

        exec(getThumbCmd, (err, stdout) => {
            if (err || !stdout.trim()) {
                sendProgress({ status: 'error', message: 'Failed to extract thumbnail URL.' });
                res.end();
                return;
            }

            const thumbUrl = stdout.trim().split('\n')[0];
            const outputPath = path.join(baseDir, `Thumbnail_${Date.now()}.jpg`);

            downloadFileNative(thumbUrl, outputPath, (dlErr) => {
                if (dlErr) {
                    sendProgress({ status: 'error', message: 'Failed to save image: ' + dlErr.message });
                } else {
                    sendProgress({ percent: 100, status: 'completed', message: `Saved to ${baseDir}` });
                    if (!isWin) exec(`osascript -e 'display notification "Thumbnail Saved!" with title "Media Downloader"'`);
                }
                res.end();
            });
        });
        return;
    }

    // মূল ডাউনলোড কমান্ড (ffmpeg পাথ যুক্ত করা হয়েছে)
    let args = ['--ffmpeg-location', ffmpegPath, '--no-playlist', '-o', outputTemplate];

    if (useCookies === 'true') {
        args.push('--cookies-from-browser', 'chrome');
    }

    if (downloadMainMedia === 'false') {
        args.push('--skip-download');
    }

    if (downloadThumb === 'true') {
        args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
    }

    if (downloadSub === 'true') {
        args.push('--write-sub', '--sub-lang', 'en,bn', '--embed-subs');
    }

    if (startTime || endTime) {
        const start = startTime || '00:00:00';
        const end = endTime ? `-${endTime}` : '';
        args.push('--download-sections', `*${start}${end}`);
    }

    let ffmpegArgs = [];
    if (convertGif === 'true') {
        ffmpegArgs.push('fps=15,scale=480:-1:flags=lanczos');
        args.push('--extract-audio', '--audio-format', 'gif');
    } else if (cropShorts === 'true') {
        ffmpegArgs.push('crop=ih*(9/16):ih');
    }

    if (ffmpegArgs.length > 0) {
        args.push('--postprocessor-args', `ffmpeg:${ffmpegArgs.join(',')}`);
    }

    if (downloadMainMedia !== 'false') {
        if (quality === 'audio_mp3') {
            args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail', '--add-metadata');
        } else if (quality === 'audio_wav') {
            args.push('-x', '--audio-format', 'wav');
        } else {
            // H.264 MP4 ফরম্যাট বাধ্য করা
            args.push('--recode-video', 'mp4');
            if (resolution && resolution !== 'best') {
                args.push('-f', `bv*[height<=${resolution}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${resolution}]+ba/b`);
            } else {
                args.push('-f', 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b');
            }
        }
    }

    args.push('-P', baseDir, url);

    console.log(`Executing: "${ytDlpPath}" ${args.join(' ')}`);

    // সিস্টেমের yt-dlp এর বদলে লোকাল ytDlpPath ভেরিয়েবল ব্যবহার
    const child = spawn(ytDlpPath, args);

    child.stdout.on('data', (data) => {
        const str = data.toString();
        const match = str.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) {
            sendProgress({ percent: parseFloat(match[1]), status: 'downloading' });
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`yt-dlp stderr: ${data.toString()}`);
    });

    child.on('close', (code) => {
        if (code === 0) {
            const msg = isMultiple 
                ? `Files grouped in dedicated folder inside ${baseDir}` 
                : `Saved to ${baseDir}`;
            sendProgress({ percent: 100, status: 'completed', message: msg });
            if (!isWin) exec(`osascript -e 'display notification "Task Completed!" with title "Media Downloader"'`);
        } else {
            sendProgress({ status: 'error', message: 'Download failed. Check URL or options.' });
        }
        res.end();
    });
});

const PORT = 5005;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));