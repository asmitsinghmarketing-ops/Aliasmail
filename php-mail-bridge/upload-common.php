<?php
declare(strict_types=1);

const UPLOAD_CHUNK_BYTES = 128 * 1024;
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL = 3600;
const COMPLETED_UPLOAD_TTL = 31 * 86400;

function upload_dir(): string {
    $dir = rtrim(config_value('MAIL_UPLOAD_DIR', sys_get_temp_dir() . '/aliasmail-uploads'), '/\\');
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Could not create upload directory');
    return $dir;
}
function upload_path(string $id, string $suffix): string {
    if (!preg_match('/^[a-f0-9]{48}$/', $id)) throw new RuntimeException('Invalid upload ID');
    return upload_dir() . '/' . $id . $suffix;
}
function upload_cleanup(): void {
    foreach (glob(upload_dir() . '/*.json') ?: [] as $file) {
        $s = json_decode((string)@file_get_contents($file), true);
        if (!is_array($s) || (int)($s['expires'] ?? 0) < time()) {
            $base = substr($file, 0, -5);
            @unlink($base . '.bin'); @unlink($base . '.raw'); @unlink($base . '.lock'); @unlink($file);
        }
    }
}
function upload_manifest(array $s): string {
    return implode("\n", ['aliasmail-upload-v1', $s['id'], $s['owner'], $s['filename'], $s['contentType'], (string)$s['size'], $s['sha256'], (string)$s['expires']]);
}
function upload_start(array $body): array {
    if (random_int(1, 20) === 1) upload_cleanup();
    $size = (int)($body['size'] ?? 0); $name = trim((string)($body['filename'] ?? ''));
    $type = trim((string)($body['contentType'] ?? 'application/octet-stream'));
    $owner = strtolower(trim((string)($body['owner'] ?? ''))); $hash = strtolower((string)($body['sha256'] ?? ''));
    $publicKey = (string)($body['publicKey'] ?? ''); $der = base64_decode($publicKey, true);
    if ($size < 1 || $size > UPLOAD_MAX_BYTES) throw new RuntimeException('Attachment size is invalid');
    if ($name === '' || strlen($name) > 255 || str_contains($name, "\0")) throw new RuntimeException('Attachment name is invalid');
    if ($owner === '' || !preg_match('/^[a-f0-9]{64}$/', $hash)) throw new RuntimeException('Attachment metadata is invalid');
    if ($der === false || strlen($der) < 200 || strlen($der) > 600) throw new RuntimeException('Upload public key is invalid');
    $id = bin2hex(random_bytes(24));
    $s = ['kind'=>'attachment','id'=>$id,'owner'=>$owner,'filename'=>$name,'contentType'=>substr($type,0,200),'size'=>$size,
        'sha256'=>$hash,'publicKey'=>$publicKey,'expires'=>time()+UPLOAD_TTL,'nextChunk'=>0,'received'=>0,'lastHash'=>'','complete'=>false];
    $s['manifest'] = upload_manifest($s);
    file_put_contents(upload_path($id, '.json'), json_encode($s, JSON_THROW_ON_ERROR), LOCK_EX);
    $url = config_value('MAIL_UPLOAD_URL');
    if ($url === '') throw new RuntimeException('MAIL_UPLOAD_URL is not configured');
    return ['uploadId'=>$id,'uploadUrl'=>$url,'manifest'=>$s['manifest'],'chunkBytes'=>UPLOAD_CHUNK_BYTES,'expires'=>$s['expires']];
}
function with_upload(string $id, callable $callback): array {
    $lock = fopen(upload_path($id, '.lock'), 'c+');
    if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('Could not lock upload');
    try {
        $path = upload_path($id, '.json'); $s = json_decode((string)@file_get_contents($path), true);
        if (!is_array($s) || ($s['kind'] ?? '') !== 'attachment') throw new RuntimeException('Upload session not found');
        if ((int)$s['expires'] < time()) throw new RuntimeException('Upload session expired');
        $result = $callback($s); file_put_contents($path, json_encode($s, JSON_THROW_ON_ERROR), LOCK_EX); return $result;
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
function upload_chunk(string $id, int $index, string $bytes): array {
    return with_upload($id, function (&$s) use ($id,$index,$bytes): array {
        if ($s['complete']) throw new RuntimeException('Upload is already complete');
        $hash = hash('sha256', $bytes);
        if ($index === (int)$s['nextChunk']-1 && hash_equals((string)$s['lastHash'], $hash)) return ['ok'=>true,'nextChunk'=>$s['nextChunk']];
        $expected = min(UPLOAD_CHUNK_BYTES, (int)$s['size']-(int)$s['received']);
        if ($index !== (int)$s['nextChunk'] || $expected < 1 || strlen($bytes) !== $expected) throw new RuntimeException('Unexpected attachment chunk');
        if (file_put_contents(upload_path($id,'.bin'), $bytes, FILE_APPEND|LOCK_EX) !== strlen($bytes)) throw new RuntimeException('Could not save attachment chunk');
        $s['received'] += strlen($bytes); $s['nextChunk']++; $s['lastHash'] = $hash;
        return ['ok'=>true,'nextChunk'=>$s['nextChunk'],'received'=>$s['received']];
    });
}
function public_key_pem(string $key): string { return "-----BEGIN PUBLIC KEY-----\n".chunk_split($key,64,"\n")."-----END PUBLIC KEY-----\n"; }
function upload_finalize(string $id, string $signature): array {
    return with_upload($id, function (&$s) use ($id,$signature): array {
        if ($s['complete']) return ['ok'=>true,'attachmentId'=>$id];
        $file = upload_path($id,'.bin');
        if ((int)$s['received'] !== (int)$s['size'] || !hash_equals((string)$s['sha256'], hash_file('sha256',$file))) throw new RuntimeException('Attachment hash verification failed');
        $sig = base64_decode($signature,true); $key = openssl_pkey_get_public(public_key_pem((string)$s['publicKey']));
        if ($sig === false || !$key || openssl_verify((string)$s['manifest'],$sig,$key,OPENSSL_ALGO_SHA256) !== 1) throw new RuntimeException('Attachment signature verification failed');
        $s['complete']=true; $s['expires']=time()+COMPLETED_UPLOAD_TTL;
        return ['ok'=>true,'attachmentId'=>$id,'filename'=>$s['filename'],'size'=>$s['size']];
    });
}
function upload_consume(string $id, string $owner): array {
    return with_upload($id, function (&$s) use ($id,$owner): array {
        if (!$s['complete'] || !hash_equals((string)$s['owner'],strtolower($owner))) throw new RuntimeException('Attachment is not available');
        $bytes=file_get_contents(upload_path($id,'.bin')); if ($bytes===false) throw new RuntimeException('Attachment file is unavailable');
        return ['filename'=>$s['filename'],'contentType'=>$s['contentType'],'size'=>$s['size'],'content'=>base64_encode($bytes)];
    });
}
function upload_delete(string $id,string $owner): array {
    with_upload($id,function (&$s) use($owner): array {
        if(!hash_equals((string)$s['owner'],strtolower($owner)))throw new RuntimeException('Attachment is not available');
        return ['ok'=>true];
    });
    @unlink(upload_path($id,'.bin'));@unlink(upload_path($id,'.json'));@unlink(upload_path($id,'.lock'));return ['ok'=>true];
}
function raw_start(int $size,string $hash): array {
    if ($size<1 || $size>64*1024*1024 || !preg_match('/^[a-f0-9]{64}$/',$hash)) throw new RuntimeException('Invalid staged message');
    $id=bin2hex(random_bytes(24)); $s=['kind'=>'raw','id'=>$id,'size'=>$size,'sha256'=>$hash,'received'=>0,'expires'=>time()+UPLOAD_TTL];
    file_put_contents(upload_path($id,'.json'),json_encode($s,JSON_THROW_ON_ERROR),LOCK_EX); return ['rawId'=>$id];
}
function raw_append(string $id,string $encoded): array {
    $bytes=base64_decode($encoded,true); if($bytes===false||strlen($bytes)>UPLOAD_CHUNK_BYTES) throw new RuntimeException('Invalid staged message chunk');
    $path=upload_path($id,'.json'); $s=json_decode((string)@file_get_contents($path),true);
    if(!is_array($s)||($s['kind']??'')!=='raw'||(int)$s['expires']<time()||(int)$s['received']+strlen($bytes)>(int)$s['size']) throw new RuntimeException('Staged message not found');
    if(file_put_contents(upload_path($id,'.raw'),$bytes,FILE_APPEND|LOCK_EX)!==strlen($bytes)) throw new RuntimeException('Could not stage message');
    $s['received']+=strlen($bytes); file_put_contents($path,json_encode($s,JSON_THROW_ON_ERROR),LOCK_EX); return ['ok'=>true];
}
function raw_read(string $id): string {
    $s=json_decode((string)@file_get_contents(upload_path($id,'.json')),true); $path=upload_path($id,'.raw');
    if(!is_array($s)||($s['kind']??'')!=='raw'||(int)$s['received']!==(int)$s['size']||!is_file($path)||!hash_equals((string)$s['sha256'],hash_file('sha256',$path))) throw new RuntimeException('Staged message verification failed');
    $raw=file_get_contents($path); if($raw===false) throw new RuntimeException('Staged message unavailable'); return $raw;
}
function raw_delete(string $id): void { @unlink(upload_path($id,'.raw')); @unlink(upload_path($id,'.json')); @unlink(upload_path($id,'.lock')); }
