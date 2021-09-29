const { app, BrowserWindow, ipcMain, Tray, Menu, MenuItem, shell, session, clipboard, screen } = require('electron')
const fs = require('fs')

const { ElectronBlocker } = require('@cliqz/adblocker-electron')
const fetch = require('cross-fetch')

Array.prototype.nsort = function (callback) {
  // [JavaScriptで文字列と数字が混在したソート - Qiita](https://qiita.com/RAWSEQ/items/99f40ec11eef995dc174)
  const arr = this
  callback ??= a => a
  return arr.sort((a, b) => {
    const sa = callback(a).replace(/(\d+)/g, m => m.padStart(30, '0'))
    const sb = callback(b).replace(/(\d+)/g, m => m.padStart(30, '0'))
    return sa < sb ? -1 : sa > sb ? 1 : 0
  })
}


let tray = null
let win = null


const iconPath = app.isPackaged ?
  `${__dirname}/assets/Movie icon -16x16-fff.png`
: `${__dirname}/assets/Movie icon -16x16-tomato.png`


const loadSettings = async () => {
  const defaultSettingsText = `
try {
  module.exports = {
    importDirectories: [
      '~/Movies',
    ],
  }
} catch {}

try {
  window.settings = {
    playlistFilters: [
      { id: 'Movies', test: /\\/Movies/ },
    ],
    parseFileitem: item => item,
    parseDiritem: item => item,
  }
} catch {}
`

  // create app directory if not exist
  const homedir = require('os').homedir()
  fs.mkdirSync(`${homedir}/.${app.name}`, { recursive: true })

  // create settings file if not exist
  const settingsPath = `${homedir}/.${app.name}/settings.js`
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, defaultSettingsText, { encoding: 'utf8' })
  }

  // read settings file
  const requireIfExists = path => {
    try {
      return require(path)
    } catch (error) {
      console.log(error)
      return null
    }
  }
  delete require.cache[settingsPath]
  const settings = require(settingsPath)
  // const settings = requireIfExists(settingsPath) ?? {}
  // const settings = {}

  // crawl importDirectories
  const diritems = await crawl(settings.importDirectories?.map?.(dirpath => dirpath.replace(/^~/, homedir)) ?? [])

  return { settings, diritems }
}
const crawl = async (dirpathes) => {
  // ディレクトリ構成とmp4ファイルを再起的に走査

  let diritems = []
  for (const dirpath of dirpathes) {

    if ([
      /node_modules$/,
      /dist$/,
    ].some(p => p.test(dirpath))) continue

    const dirents = await fs.promises.readdir(dirpath, { withFileTypes: true })

    const diritem = {
      dirpath,
      dirname: dirpath.match(/([^\/]+)$/)?.[1],
      fileitems: dirents
        .filter(dirent => dirent.isFile())
        .filter(dirent => /^[^\.].+\.mp[34]$/i.test(dirent.name))
        .map(dirent => ({
          dirpath,
          filename: dirent.name,
          filepath: dirpath + '/' + dirent.name,
        }))
        .nsort(fileitem => fileitem.filename),
      subdirpathes: dirents
        .filter(dirent => dirent.isDirectory())
        .filter(dirent => /^[^\.]/.test(dirent.name))
        .map(dirent => dirpath + '/' + dirent.name)
        .nsort(),
    }

    const subdiritems = await crawl(diritem.subdirpathes)

    diritems = [ ...diritems, diritem, ...subdiritems ]
  }

  diritems = diritems.filter(diritem => diritem.fileitems.length > 0)
  return diritems
}


const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 450,
    backgroundColor: '#000',
    frame: false,
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      webviewTag: true,
    },
  })
  win.setWindowButtonVisibility(false)
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) // See https://github.com/electron/electron/issues/25368
  // win.setMenu(null)
  win.setAspectRatio(16/9)
  // win.setAspectRatio(0)

  win.loadURL(`file://${__dirname}/index.html`)

  if (!app.isPackaged) win.openDevTools()

  ElectronBlocker.fromPrebuiltAdsAndTracking(fetch)
  .then(blocker => blocker.enableBlockingInSession(win.webContents.session))

  return win
}


const createMenu = (win) => {
  const menu = new Menu()

  menu.append(new MenuItem({
    label: '50% width',
    click: () => {
      const { x, y, width, height } = win.getBounds()
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = screen.getDisplayNearestPoint({ x, y }).workArea
      win.setSize(Math.round(displayWidth / 2), Math.round(height * (displayWidth / 2) / width), true)
    },
  }))
  menu.append(new MenuItem({
    type: 'checkbox',
    checked: win.isFullScreen(),
    // accelerator: 'Cmd+F',
    label: 'Full Screen',
    click: () => win.fullScreen = !win.fullScreen,
  }))
  menu.append(new MenuItem({
    type: 'checkbox',
    checked: win.isMaximized(),
    label: 'Maximize',
    click: () => win.isMaximized() ? win.unmaximize() : win.maximize(),
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({
    label: `Open ~/.${app.name}/settings.js`,
    click: () => shell.openPath(`${require('os').homedir()}/.${app.name}/settings.js`)
  }))
  menu.append(new MenuItem({
    label: `Reveal ~/.${app.name}/ in Finder`,
    click: () => shell.showItemInFolder(`${require('os').homedir()}/.${app.name}/settings.js`)
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({
    label: 'Open DevTools',
    click: () => win?.openDevTools?.(),
  }))
  menu.append(new MenuItem({
    label: `Reveal .`,
    click: () => shell.showItemInFolder(app.getAppPath())
  }))
  menu.append(new MenuItem({
    label: `Reveal userDara`,
    click: () => shell.showItemInFolder(app.getPath('userData'))
  }))
  menu.append(new MenuItem({ type: 'separator' }))
  menu.append(new MenuItem({ role: 'quit' }))

  return menu
}


app.on('ready', () => {
  app.isPackaged && app.dock.hide()

  ipcMain
    .on('log', console.log)
    .on('clipboard.writeText', (event, text) => clipboard.writeText(text))
    .on('homedir', (event) => event.returnValue = require('os').homedir())
    .on('load-settings', async (event) => event.returnValue = await loadSettings())

  tray = new Tray(iconPath)

  win = createWindow()
  ipcMain
    .on('win.hide', () => win.hide())
    .on('win.setAspectRatio', (event, r) => win.setAspectRatio(r))
    .on('win.toggleFullScreen', () => win.fullScreen = !win.fullScreen)
    // .on('win.toggleMaximized', () => win.isMaximized() ? win.unmaximize() : win.maximize())
    .on('win.toggleMaximized', () => {
      if (win.isMaximized() && !win.fullScreen) {
        win.fullScreen = true
      } else if (!win.isMaximized() && win.fullScreen) {
        win.fullScreen = false
      } else if (!win.isMaximized() && !win.fullScreen) {
        win.maximize()
      } else {
        // win.isMaximized() && win.fullScreen
        win.fullScreen = false
        win.unmaximize()
      }
    })
    .on('win.toRight', () => {
      const { x, y, width, height } = win.getBounds()
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = screen.getDisplayNearestPoint({ x, y }).workArea
      win.setBounds({ x: displayX + displayWidth - width, y, width, height })
    })
    .on('win.toLeft', () => {
      const { x, y, width, height } = win.getBounds()
      const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = screen.getDisplayNearestPoint({ x, y }).workArea
      win.setBounds({ x: displayX, y, width, height })
    })

  tray.on('click', () => win.isVisible() ? win.hide() : win.show())

  // tray.setContextMenu(menu)
  // tray.on('right-click', () => tray.popUpContextMenu(menu))
  tray.on('right-click', () => tray.popUpContextMenu(createMenu(win)))
})
// asar extract app.asar tmp

app.on('quit', () => {
  console.log('@app.quit')
  // session.defaultSession.clearCache(() => {})
})

