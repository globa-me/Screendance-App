import { mkdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

if (process.env.SCREENDANCE_USER_DATA_DIR) {
	const isolatedUserDataPath = path.resolve(process.env.SCREENDANCE_USER_DATA_DIR);
	mkdirSync(isolatedUserDataPath, { recursive: true, mode: 0o700 });
	app.setPath("userData", isolatedUserDataPath);
	app.setPath("sessionData", path.join(isolatedUserDataPath, "session"));
} else if (process.env["VITE_DEV_SERVER_URL"]) {
	const devUserDataPath = path.join(app.getPath("appData"), "Screendance App-dev");
	app.setPath("userData", devUserDataPath);
	app.setPath("sessionData", path.join(devUserDataPath, "session"));
}

export const USER_DATA_PATH = app.getPath("userData");
export const RECORDINGS_DIR = path.join(USER_DATA_PATH, "recordings");
