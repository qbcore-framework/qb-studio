# Vue NUI starter

The checked-in `html/dist` folder is the local UI loaded by Cfx, so this resource works without a development server.

To edit and rebuild it, install a Node.js version supported by the pinned Vite toolchain (`20.19+` or `22.12+`):

```powershell
cd html
npm ci
npm run dev
npm run build
```

Vite uses a relative asset base for Cfx NUI. Do not point `ui_page` at localhost in a distributed resource.
