const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');
const morgan = require('morgan');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());
app.use(morgan('combined', {
    stream: fs.createWriteStream(path.join(__dirname, 'logs/access.log'), { flags: 'a' })
}));

// زيادة المهلة الزمنية في express
const server = app.listen(3001, () => {
    console.log('Server started on port 3001');
});
server.setTimeout(120000); // تعيين المهلة الزمنية إلى 120 ثانية

const db = new sqlite3.Database('./news_ticker.db', (err) => {
    if (err) {
        console.error('Failed to connect to the database', err);
    } else {
        console.log('Connected to the SQLite database');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS devices (
                serial TEXT PRIMARY KEY,
                name TEXT,
                active INTEGER DEFAULT 1,
                addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS ticker (
                id INTEGER PRIMARY KEY,
                text TEXT,
                icon TEXT,
                separator_icon TEXT,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY,
                name TEXT,
                logo TEXT,
                type TEXT,
                league TEXT,
                continent TEXT
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY,
                team1_id INTEGER,
                team2_id INTEGER,
                matchTime TEXT,
                channel TEXT,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(team1_id) REFERENCES teams(id),
                FOREIGN KEY(team2_id) REFERENCES teams(id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS leagues (
                id INTEGER PRIMARY KEY,
                name TEXT
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS continents (
                id INTEGER PRIMARY KEY,
                name TEXT
            )`);

            // تحقق من الأعمدة الموجودة قبل الإضافة
            db.all(`PRAGMA table_info(teams)`, [], (err, columns) => {
                if (err) {
                    console.error('Failed to get columns info', err);
                } else {
                    const columnNames = columns.map(col => col.name);
                    if (!columnNames.includes('league')) {
                        db.run(`ALTER TABLE teams ADD COLUMN league TEXT`);
                    }
                    if (!columnNames.includes('continent')) {
                        db.run(`ALTER TABLE teams ADD COLUMN continent TEXT`);
                    }
                }
            });

            // إضافة الدوريات الافتراضية
            const leagues = ['الاسباني', 'الانجليزي', 'الايطالي', 'السعودي', 'اخرى'];
            leagues.forEach(league => {
                db.run(`INSERT INTO leagues (name) VALUES (?)`, [league]);
            });

            // إضافة القارات الافتراضية
            const continents = ['إفريقيا', 'أوروبا', 'آسيا', 'أمريكا الشمالية', 'أمريكا الجنوبية', 'أستراليا', 'أنتاركتيكا'];
            continents.forEach(continent => {
                db.run(`INSERT INTO continents (name) VALUES (?)`, [continent]);
            });
        });
    }
});
// API لجلب البيانات من جداول الدوريات والقارات
app.get('/api/leagues', (req, res) => {
    db.all('SELECT * FROM leagues', [], (err, rows) => {
        if (err) {
            res.status(400).json({ error: err.message });
            return;
        }
        res.json({ data: rows });
    });
});

app.get('/api/continents', (req, res) => {
    db.all('SELECT * FROM continents', [], (err, rows) => {
        if (err) {
            res.status(400).json({ error: err.message });
            return;
        }
        res.json({ data: rows });
    });
});


app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));

function checkAuth(req, res, next) {
    if (req.session.user) {
        return next();
    } else {
        res.redirect('/login');
    }
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); // مسار التخزين
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
// التحقق من صلاحية الجهاز قبل السماح بتنزيل الملفات
app.use('/downloads/*', (req, res, next) => {
    const serial = req.query.user;
    console.log(`Received request with serial: ${serial}`);

    if (!serial) {
        console.log('Access denied: No serial provided');
        return res.status(403).send('Forbidden');
    }

    db.get('SELECT active FROM devices WHERE serial = ?', [serial], (err, device) => {
        if (err) {
            console.log(`Access denied: Database error: ${err}`);
            return res.status(500).send('Server Error');
        }
        if (!device) {
            console.log(`Access denied: Device not found for serial: ${serial}`);
            return res.status(403).send('Forbidden');
        }
        if (!device.active) {
            console.log(`Access denied: Device ${serial} is not active`);
            return res.status(403).send('Forbidden');
        }
        console.log(`Access granted for serial: ${serial}`);

        const filePath = path.join(__dirname, 'downloads', req.params[0]);
        res.sendFile(filePath, (err) => {
            if (err) {
                console.log(`Error sending file: ${err}`);
                if (!res.headersSent) { // تأكد من أن الرؤوس لم ترسل بعد
                    res.status(500).send('Server Error');
                }
            } else {
                console.log(`File sent: ${filePath}`);
            }
        });
    });
});

// منع الوصول المباشر للملفات من المتصفح
app.use('/downloads', (req, res, next) => {
    console.log('Direct access attempt blocked.');
    return res.status(403).send('Forbidden');
});

app.get('/login', (req, res) => {
    res.send('<form action="/login" method="post"><input type="text" name="user" placeholder="Username"><input type="password" name="pass" placeholder="Password"><input type="submit" value="Login"></form>');
});

app.post('/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === 'admin' && pass === 'password') {
        req.session.user = user;
        res.redirect('/admin');
    } else {
        res.send('Invalid credentials');
    }
});

app.get('/admin', checkAuth, (req, res) => {
    res.send(`
        <h2>Admin Dashboard</h2>
        <a href="/admin/ticker"><img src="/path/to/icon1.png" alt="Manage Ticker" /></a>
        <a href="/admin/matches"><img src="/path/to/icon2.png" alt="Manage Matches" /></a>
        <a href="/admin/teams"><img src="/path/to/icon3.png" alt="Manage Teams" /></a>
        <a href="/admin/devices"><img src="/path/to/icon4.png" alt="Manage Devices" /></a>
        <a href="/up"><img src="/path/to/icon5.png" alt="Upload Watch Page" /></a>
        <a href="/admin/logs"><img src="/path/to/icon6.png" alt="View Logs" /></a>
    `);
});
// صفحة إدارة الأخبار
app.get('/admin/ticker', checkAuth, (req, res) => {
    db.all('SELECT * FROM ticker ORDER BY updatedAt DESC', [], (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            let tickerList = rows.map(row => `
                <tr>
                    <td>${row.text}</td>
                    <td>${row.icon ? `<img src="/uploads/${row.icon}" height="50">` : 'No Icon'}</td>
                    <td>
                        <form action="/edit-ticker" method="post">
                            <input type="hidden" name="id" value="${row.id}">
                            <input type="text" name="text" value="${row.text}" required>
                            <input type="submit" value="Edit">
                        </form>
                        <form action="/delete-ticker" method="post" style="display:inline;">
                            <input type="hidden" name="id" value="${row.id}">
                            <input type="submit" value="Delete" onclick="return confirm('Are you sure you want to delete this ticker?');">
                        </form>
                    </td>
                </tr>
            `).join('');
            res.send(`
                <h2>Manage Ticker</h2>
                <button onclick="window.location.href='/admin'">Return to Main Menu</button>
                <form action="/add-ticker" method="post" enctype="multipart/form-data">
                    <input type="text" name="text" placeholder="Enter ticker text" required>
                    <input type="file" name="icon" accept="image/*">
                    <input type="submit" value="Add Ticker">
                </form>
                <form action="/update-separator" method="post" enctype="multipart/form-data">
                    <input type="file" name="separator_icon" accept="image/*" required>
                    <input type="submit" value="Update Separator Icon">
                </form>
                <table>
                    <thead>
                        <tr>
                            <th>Text</th>
                            <th>Icon</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>${tickerList}</tbody>
                </table>
            `);
        }
    });
});

app.post('/add-ticker', checkAuth, upload.single('icon'), (req, res) => {
    const { text } = req.body;
    const icon = req.file ? req.file.filename : null;

    db.run('INSERT INTO ticker (text, icon, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)', [text, icon], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/ticker');
        }
    });
});

app.post('/edit-ticker', checkAuth, (req, res) => {
    const { id, text } = req.body;
    db.run('UPDATE ticker SET text = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [text, id], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/ticker');
        }
    });
});

app.post('/delete-ticker', checkAuth, (req, res) => {
    const { id } = req.body;
    db.run('DELETE FROM ticker WHERE id = ?', [id], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/ticker');
        }
    });
});

app.post('/update-separator', checkAuth, upload.single('separator_icon'), (req, res) => {
    const separator_icon = req.file.filename;
    db.run('UPDATE ticker SET separator_icon = ? WHERE id = 1', [separator_icon], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/ticker');
        }
    });
});
// صفحة إدارة المباريات
app.get('/admin/matches', checkAuth, (req, res) => {
    db.all('SELECT * FROM teams ORDER BY name', [], (err, teams) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.send(`
                <h2>تحديث المباريات</h2>
                <button onclick="window.location.href='/admin'">Return to Main Menu</button>
                <form action="/update-match" method="post">
                    <select name="teamType" id="teamType" onchange="updateTeamsOptions()" required>
                        <option value="">حدد نوع الفريق</option>
                        <option value="Club">نادي</option>
                        <option value="National">منتخب</option>
                    </select>
                    <select name="team1" id="team1" required>
                        <option value="">حدد الفريق الأول</option>
                    </select>
                    <select name="team2" id="team2" required>
                        <option value="">حدد الفريق الثاني</option>
                    </select>
                    <input type="text" name="matchTime" placeholder="Match Time" required>
                    <input type="text" name="channel" placeholder="Channel" required>
                    <input type="submit" value="Update Match">
                </form>
                <button onclick="window.location.href='/delete-matches'">مسح محتوى جدول المباريات</button>
                <script>
                    const teams = ${JSON.stringify(teams)};

                    function updateTeamsOptions() {
                        const teamType = document.getElementById('teamType').value;
                        const team1Select = document.getElementById('team1');
                        const team2Select = document.getElementById('team2');

                        const filteredTeams = teams.filter(team => team.type === teamType);

                        team1Select.innerHTML = '<option value="">حدد الفريق الأول</option>' + filteredTeams.map(team => \`<option value="\${team.id}">\${team.name}</option>\`).join('');
                        team2Select.innerHTML = '<option value="">حدد الفريق الثاني</option>' + filteredTeams.map(team => \`<option value="\${team.id}">\${team.name}</option>\`).join('');
                    }
                </script>
            `);
        }
    });
});

app.post('/update-match', checkAuth, (req, res) => {
    const { team1, team2, matchTime, channel } = req.body;
    db.run('INSERT INTO matches (team1_id, team2_id, matchTime, channel, updatedAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [team1, team2, matchTime, channel], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/matches');
        }
    });
});

app.get('/delete-matches', checkAuth, (req, res) => {
    db.run('DELETE FROM matches', (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/matches');
        }
    });
});

function updateTeamsOptions() {
    const teamType = document.getElementById('teamType').value;
    const team1Select = document.getElementById('team1');
    const team2Select = document.getElementById('team2');
    
    let filteredTeams = teams.filter(team => team.type === teamType);

    team1Select.innerHTML = filteredTeams.map(team => `<option value="${team.id}">${team.name}</option>`).join('');
    team2Select.innerHTML = filteredTeams.map(team => `<option value="${team.id}">${team.name}</option>`).join('');
}
app.get('/admin/teams', checkAuth, (req, res) => {
    const message = req.query.message;
    const clubSort = req.query.clubSort || 'addition';
    const nationalSort = req.query.nationalSort || 'addition';
    const clubFilter = req.query.clubFilter || '';
    const nationalFilter = req.query.nationalFilter || '';

    const getSortedTeams = (teams, type, sort, filter) => {
        let sortedTeams = teams.filter(team => team.type === type);
        if (filter) {
            if (type === 'Club') {
                sortedTeams = sortedTeams.filter(team => team.league === filter);
            } else if (type === 'National') {
                sortedTeams = sortedTeams.filter(team => team.continent === filter);
            }
        }
        if (sort === 'alphabetical') {
            sortedTeams.sort((a, b) => a.name.localeCompare(b.name));
        }
        return sortedTeams;
    };

    db.all('SELECT * FROM teams', [], (err, teams) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            db.all('SELECT DISTINCT name FROM leagues', [], (err, leagues) => {
                if (err) {
                    res.status(500).send(err.message);
                } else {
                    db.all('SELECT DISTINCT name FROM continents', [], (err, continents) => {
                        if (err) {
                            res.status(500).send(err.message);
                        } else {
                            let clubsTable = getSortedTeams(teams, 'Club', clubSort, clubFilter).map(team => `
                                <tr>
                                    <td>${team.name}</td>
                                    <td><img src="/${team.logo}" height="50"></td>
                                    <td>${team.type}</td>
                                    <td>${team.league || '-'}</td>
                                    <td>
                                        <form action="/update-team" method="post" enctype="multipart/form-data">
                                            <input type="hidden" name="teamId" value="${team.id}">
                                            <input type="text" name="name" value="${team.name}" required>
                                            <input type="file" name="logo" accept="image/*">
                                            <select name="league" ${team.league ? 'disabled' : ''} required>
                                                ${leagues.map(league => `<option value="${league.name}" ${league.name === team.league ? 'selected' : ''}>${league.name}</option>`).join('')}
                                            </select>
                                            <select name="type" required>
                                                <option value="Club" ${team.type === 'Club' ? 'selected' : ''}>نادي</option>
                                                <option value="National" ${team.type === 'National' ? 'selected' : ''}>منتخب</option>
                                            </select>
                                            <input type="submit" value="تحديث">
                                        </form>
                                    </td>
                                    <td>
                                        <form action="/delete-team" method="post">
                                            <input type="hidden" name="teamId" value="${team.id}">
                                            <input type="submit" value="حذف" onclick="return confirm('هل أنت متأكد أنك تريد حذف هذا الفريق؟');">
                                        </form>
                                    </td>
                                </tr>
                            `).join('');

                            let nationalsTable = getSortedTeams(teams, 'National', nationalSort, nationalFilter).map(team => `
                                <tr>
                                    <td>${team.name}</td>
                                    <td><img src="/${team.logo}" height="50"></td>
                                    <td>${team.type}</td>
                                    <td>${team.continent || '-'}</td>
                                    <td>
                                        <form action="/update-team" method="post" enctype="multipart/form-data">
                                            <input type="hidden" name="teamId" value="${team.id}">
                                            <input type="text" name="name" value="${team.name}" required>
                                            <input type="file" name="logo" accept="image/*">
                                            <select name="continent" ${team.continent ? 'disabled' : ''} required>
                                                ${continents.map(continent => `<option value="${continent.name}" ${continent.name === team.continent ? 'selected' : ''}>${continent.name}</option>`).join('')}
                                            </select>
                                            <select name="type" required>
                                                <option value="Club" ${team.type === 'Club' ? 'selected' : ''}>نادي</option>
                                                <option value="National" ${team.type === 'National' ? 'selected' : ''}>منتخب</option>
                                            </select>
                                            <input type="submit" value="تحديث">
                                        </form>
                                    </td>
                                    <td>
                                        <form action="/delete-team" method="post">
                                            <input type="hidden" name="teamId" value="${team.id}">
                                            <input type="submit" value="حذف" onclick="return confirm('هل أنت متأكد أنك تريد حذف هذا الفريق؟');">
                                        </form>
                                    </td>
                                </tr>
                            `).join('');

                            res.send(`
                                <h2>تحديث الفرق</h2>
                                <button onclick="window.location.href='/admin'">العودة إلى القائمة الرئيسية</button>
                                <h3>إضافة فريق جديد</h3>
                                <form id="addTeamForm" action="/add-team" method="post" enctype="multipart/form-data">
                                    <input type="text" name="name" placeholder="اسم الفريق" required>
                                    <input type="file" name="logo" accept="image/*" required>
                                    <select id="teamType" name="type" required onchange="toggleLeagueContinent()">
                                        <option value="">اختر النوع</option>
                                        <option value="Club">نادي</option>
                                        <option value="National">منتخب</option>
                                    </select>
                                    <div id="leagueDiv" style="display:none;">
                                        <select name="league" required>
                                            ${leagues.map(league => `<option value="${league.name}">${league.name}</option>`).join('')}
                                        </select>
                                    </div>
                                    <div id="continentDiv" style="display:none;">
                                        <select name="continent" required>
                                            ${continents.map(continent => `<option value="${continent.name}">${continent.name}</option>`).join('')}
                                        </select>
                                    </div>
                                    <input type="submit" value="إضافة فريق">
                                    ${message ? `<p style="color: red;">${message}</p>` : ''}
                                </form>
                                <div style="display: flex; justify-content: space-between; margin-top: 20px;">
                                    <div style="width: 48%; border: 2px solid black; padding: 10px;">
                                        <h3>أندية</h3>
                                        <form method="get" action="/admin/teams">
                                            <input type="hidden" name="nationalSort" value="${nationalSort}">
                                            <select name="clubSort" onchange="this.form.submit()">
                                                <option value="addition" ${clubSort === 'addition' ? 'selected' : ''}>الاضافة</option>
                                                <option value="alphabetical" ${clubSort === 'alphabetical' ? 'selected' : ''}>الابجدية</option>
                                            </select>
                                            <select name="clubFilter" onchange="this.form.submit()">
                                                <option value="">كل الدوريات</option>
                                                ${leagues.map(league => `<option value="${league.name}">${league.name}</option>`).join('')}
                                            </select>
                                        </form>
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>اسم الفريق</th>
                                                    <th>الشعار</th>
                                                    <th>نوع الفريق</th>
                                                    <th>الدوري</th>
                                                    <th>إجراءات</th>
                                                    <th>حذف</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${clubsTable}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div style="width: 48%; border: 2px solid black; padding: 10px;">
                                        <h3>منتخبات</h3>
                                        <form method="get" action="/admin/teams">
                                            <input type="hidden" name="clubSort" value="${clubSort}">
                                            <select name="nationalSort" onchange="this.form.submit()">
                                                <option value="addition" ${nationalSort === 'addition' ? 'selected' : ''}>الاضافة</option>
                                                <option value="alphabetical" ${nationalSort === 'alphabetical' ? 'selected' : ''}>الابجدية</option>
                                            </select>
                                            <select name="nationalFilter" onchange="this.form.submit()">
                                                <option value="">كل القارات</option>
                                                ${continents.map(continent => `<option value="${continent.name}">${continent.name}</option>`).join('')}
                                            </select>
                                        </form>
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>اسم الفريق</th>
                                                    <th>الشعار</th>
                                                    <th>نوع الفريق</th>
                                                    <th>القارة</th>
                                                    <th>إجراءات</th>
                                                    <th>حذف</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${nationalsTable}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                <script>
                                    function toggleLeagueContinent() {
                                        const teamType = document.getElementById('teamType').value;
                                        document.getElementById('leagueDiv').style.display = teamType === 'Club' ? 'block' : 'none';
                                        document.getElementById('continentDiv').style.display = teamType === 'National' ? 'block' : 'none';
                                    }
                                </script>
                            `);
                        }
                    });
                }
            });
        }
    });
});

// إضافة فريق جديد
app.post('/add-team', checkAuth, upload.single('logo'), (req, res) => {
    const { name, type, league, continent } = req.body;
    const logoPath = req.file ? req.file.path : null;
    const logoFileName = logoPath ? `resized_${req.file.filename}` : null;

    db.get('SELECT * FROM teams WHERE name = ?', [name], (err, row) => {
        if (row) {
            res.redirect('/admin/teams?message=الفريق تم اضافته سابقاً');
        } else {
            const addTeam = (logoFilePath) => {
                db.run('INSERT INTO teams (name, logo, type, league, continent) VALUES (?, ?, ?, ?, ?)', [name, logoFilePath, type, league, continent], (err) => {
                    if (err) {
                        res.status(500).send(err.message);
                    } else {
                        res.redirect('/admin/teams');
                    }
                });
            };

            if (logoPath) {
                sharp(logoPath)
                    .resize(50, 50)
                    .toFile(`uploads/${logoFileName}`, (err) => {
                        if (err) {
                            res.status(500).send(err.message);
                        } else {
                            addTeam(`uploads/${logoFileName}`);
                        }
                    });
            } else {
                addTeam(null);
            }
        }
    });
});

// تحديث الفريق
app.post('/update-team', checkAuth, upload.single('logo'), (req, res) => {
    const { teamId, name, type, league, continent } = req.body;
    const logoPath = req.file ? req.file.path : null;
    const logoFileName = logoPath ? `resized_${req.file.filename}` : null;

    db.get('SELECT * FROM teams WHERE name = ? AND id != ?', [name, teamId], (err, row) => {
        if (row) {
            res.redirect('/admin/teams?message=الفريق تم اضافته سابقاً');
        } else {
            const updateTeam = (logoFilePath) => {
                db.run('UPDATE teams SET name = ?, logo = ?, type = ?, league = ?, continent = ? WHERE id = ?', [name, logoFilePath, type, league, continent, teamId], (err) => {
                    if (err) {
                        res.status(500).send(err.message);
                    } else {
                        res.redirect('/admin/teams');
                    }
                });
            };

            if (logoPath) {
                sharp(logoPath)
                    .resize(50, 50)
                    .toFile(`uploads/${logoFileName}`, (err) => {
                        if (err) {
                            res.status(500).send(err.message);
                        } else {
                            updateTeam(`uploads/${logoFileName}`);
                        }
                    });
            } else {
                db.get('SELECT logo FROM teams WHERE id = ?', [teamId], (err, row) => {
                    if (err) {
                        res.status(500).send(err.message);
                    } else {
                        updateTeam(row.logo);
                    }
                });
            }
        }
    });
});

// حذف الفريق
app.post('/delete-team', checkAuth, (req, res) => {
    const { teamId } = req.body;
    db.run('DELETE FROM teams WHERE id = ?', [teamId], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/teams');
        }
    });
});

app.get('/matches', (req, res) => {
    db.all('SELECT m.team1_id, m.team2_id, m.matchTime, m.channel, t1.name as team1Name, t2.name as team2Name, t1.logo as team1Logo, t2.logo as team2Logo FROM matches m INNER JOIN teams t1 ON m.team1_id = t1.id INNER JOIN teams t2 ON m.team2_id = t2.id ORDER BY m.updatedAt DESC', [], (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.json(rows);
        }
    });
});

app.get('/ticker', (req, res) => {
    db.all('SELECT text, icon, (SELECT separator_icon FROM ticker WHERE id = 1) as separator_icon FROM ticker ORDER BY updatedAt ASC', [], (err, rows) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.json(rows);
        }
    });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/last-message', (req, res) => {
    db.get('SELECT text FROM ticker ORDER BY updatedAt DESC LIMIT 1', [], (err, row) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.json(row || { text: 'No messages sent yet' });
        }
    });
});

// صفحة إدارة الأجهزة المسموح بها
app.get('/admin/devices', checkAuth, (req, res) => {
    db.all('SELECT * FROM devices', [], (err, devices) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            let devicesList = devices.map(device => `
                <tr>
                    <td>${device.serial}</td>
                    <td>${device.name}</td>
                    <td>${device.active ? 'Active' : 'Inactive'}</td>
                    <td>${device.addedAt}</td>
                    <td>
                        <form action="/admin/toggle-device" method="post">
                            <input type="hidden" name="serial" value="${device.serial}">
                            <input type="submit" value="${device.active ? 'Disable' : 'Enable'}">
                        </form>
                        <form action="/admin/delete-device" method="post" style="display:inline;">
                            <input type="hidden" name="serial" value="${device.serial}">
                            <input type="submit" value="Delete" onclick="return confirm('Are you sure you want to delete this device?');">
                        </form>
                    </td>
                </tr>
            `).join('');
            res.send(`
                <h2>Manage Allowed Devices</h2>
                <button onclick="window.location.href='/admin'">Return to Main Menu</button>
                <table>
                    <thead>
                        <tr>
                            <th>Serial</th>
                            <th>Name</th>
                            <th>Status</th>
                            <th>Added At</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>${devicesList}</tbody>
                </table>
                <form action="/admin/add-device" method="post">
                    <input type="text" name="serial" placeholder="Enter Serial Number" required>
                    <input type="text" name="name" placeholder="Enter Owner Name" required>
                    <input type="submit" value="Add Device">
                </form>
            `);
        }
    });
});

app.post('/admin/add-device', checkAuth, (req, res) => {
    const { serial, name } = req.body;
    db.run('INSERT INTO devices (serial, name) VALUES (?, ?)', [serial, name], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/devices');
        }
    });
});

app.post('/admin/toggle-device', checkAuth, (req, res) => {
    const { serial } = req.body;
    db.get('SELECT active FROM devices WHERE serial = ?', [serial], (err, device) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            const newStatus = device.active ? 0 : 1;
            db.run('UPDATE devices SET active = ? WHERE serial = ?', [newStatus, serial], (err) => {
                if (err) {
                    res.status(500).send(err.message);
                } else {
                    res.redirect('/admin/devices');
                }
            });
        }
    });
});

app.post('/admin/delete-device', checkAuth, (req, res) => {
    const { serial } = req.body;
    db.run('DELETE FROM devices WHERE serial = ?', [serial], (err) => {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.redirect('/admin/devices');
        }
    });
});

const uploadWatchPage = multer({ dest: 'downloads/' });

app.get('/up', checkAuth, (req, res) => {
    fs.readdir('downloads', (err, files) => {
        if (err) {
            return res.status(500).send('Could not read downloads directory');
        } else {
            let filesList = files.map(file => `<li>${file}</li>`).join('');
            res.send(`
                <h2>Upload Watch Page</h2>
                <button onclick="window.location.href='/admin'">Return to Main Menu</button>
                <form action="/up" method="post" enctype="multipart/form-data">
                    <input type="file" name="watchPage" webkitdirectory directory multiple required>
                    <input type="submit" value="Upload">
                </form>
                <h2>Uploaded Files</h2>
                <ul>${filesList}</ul>
                <form action="/delete-watch" method="post">
                    <input type="submit" value="Delete All Files" onclick="return confirm('Are you sure you want to delete all files?');">
                </form>
            `);
        }
    });
});

app.post('/up', checkAuth, uploadWatchPage.array('watchPage', 12), (req, res) => {
    const tempPaths = req.files;
    let completed = 0; // لعد الملفات المكتملة
    tempPaths.forEach(file => {
        const tempPath = file.path;
        const targetPath = path.join(__dirname, 'downloads', file.originalname);
        fs.rename(tempPath, targetPath, err => {
            if (err) {
                if (!res.headersSent) { // تأكد من أن الرؤوس لم ترسل بعد
                    return res.status(500).send(err.message);
                }
            }
            completed++;
            if (completed === tempPaths.length) { // إذا تم إعادة تسمية جميع الملفات
                res.redirect('/up');
            }
        });
    });
});


app.post('/delete-watch', checkAuth, (req, res) => {
    fs.readdir('downloads', (err, files) => {
        if (err) {
            res.status(500).send('Could not read downloads directory');
        } else {
            files.forEach(file => {
                fs.unlink(path.join('downloads', file), err => {
                    if (err) return res.status(500).send('Could not delete file');
                });
            });
            res.redirect('/up');
        }
    });
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});

// إعداد مهمة كرون لحذف المباريات عند بداية كل يوم جديد
cron.schedule('0 0 * * *', () => {
    db.run('DELETE FROM matches', (err) => {
        if (err) {
            console.error('Failed to delete matches:', err.message);
        } else {
            console.log('Matches table cleared');
        }
    });
});
