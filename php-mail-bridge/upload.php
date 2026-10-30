<?php
declare(strict_types=1);
ini_set('display_errors','0'); ini_set('log_errors','1');
require __DIR__.'/bridge-core.php'; require __DIR__.'/upload-common.php';
$origin=$_SERVER['HTTP_ORIGIN']??''; $allowed=config_value('MAIL_UPLOAD_ORIGIN');
if($allowed===''||!hash_equals($allowed,$origin)){http_response_code(403);exit;}
header('Access-Control-Allow-Origin: '.$allowed); header('Vary: Origin'); header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Upload-Id, X-Chunk-Index'); header('Cache-Control: no-store');
if($_SERVER['REQUEST_METHOD']==='OPTIONS'){http_response_code(204);exit;} header('Content-Type: application/json');
function upload_reply(int $status,array $body): never {http_response_code($status);echo json_encode($body,JSON_UNESCAPED_SLASHES);exit;}
if($_SERVER['REQUEST_METHOD']!=='POST')upload_reply(405,['error'=>'Method not allowed']);
try{
    $id=(string)($_SERVER['HTTP_X_UPLOAD_ID']??''); $action=(string)($_GET['action']??'chunk');
    if($action==='chunk'){
        $index=filter_var($_SERVER['HTTP_X_CHUNK_INDEX']??null,FILTER_VALIDATE_INT); if($index===false||$index<0)throw new RuntimeException('Invalid chunk number');
        $bytes=file_get_contents('php://input',false,null,0,UPLOAD_MAX_CHUNK_BYTES+1); if($bytes===false||strlen($bytes)>UPLOAD_MAX_CHUNK_BYTES)throw new RuntimeException('Attachment chunk is too large');
        upload_reply(200,upload_chunk($id,$index,$bytes));
    }
    if($action==='finalize'){$body=json_decode(file_get_contents('php://input'),true);upload_reply(200,upload_finalize($id,(string)($body['signature']??'')));}
    throw new RuntimeException('Unsupported upload action');
}catch(Throwable $e){error_log('[AliasMail upload] '.$e->getMessage());upload_reply(400,['error'=>$e->getMessage()]);}
