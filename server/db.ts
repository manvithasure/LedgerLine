import mysql, { type PoolConnection } from "mysql2/promise";

const password = process.env.MYSQL_PASSWORD_BASE64
  ? Buffer.from(process.env.MYSQL_PASSWORD_BASE64, "base64").toString("utf8")
  : process.env.MYSQL_PASSWORD ?? "";

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password,
  database: process.env.MYSQL_DATABASE ?? "ledgerline",
  connectionLimit: 10,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: true,
  ssl: process.env.MYSQL_SSL === "true"
    ? {
        ca: process.env.MYSQL_SSL_CA_BASE64
          ? Buffer.from(process.env.MYSQL_SSL_CA_BASE64, "base64").toString("utf8")
          : undefined,
        rejectUnauthorized: true
      }
    : undefined
});

export async function beginTransaction(connection: PoolConnection): Promise<void> {
  const dialect = process.env.DB_DIALECT ?? "mysql";
  if (dialect === "tidb") {
    await connection.query("BEGIN PESSIMISTIC");
    return;
  }
  if (dialect === "mysql") {
    await connection.beginTransaction();
    return;
  }
  throw new Error(`Unsupported DB_DIALECT: ${dialect}`);
}
