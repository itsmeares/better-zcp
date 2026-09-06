declare module "ssh2-sftp-client" {
  interface ConnectOptions {
    host: string;
    port: number;
    username: string;
    password: string;
    readyTimeout: number;
  }

  interface FileEntry {
    type: string;
    name: string;
    size?: number;
    modifyTime?: number;
  }

  interface FileStats {
    size?: number;
    isDirectory?: boolean;
  }

  class SftpClient {
    constructor(clientName?: string);
    connect(options: ConnectOptions): Promise<void>;
    end(): Promise<void>;
    list(remotePath: string): Promise<FileEntry[]>;
    stat(remotePath: string): Promise<FileStats>;
    get(remotePath: string): Promise<Buffer | string>;
    put(input: Buffer, remotePath: string): Promise<void>;
    posixRename(oldPath: string, newPath: string): Promise<void>;
    delete(remotePath: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
  }

  export default SftpClient;
}
