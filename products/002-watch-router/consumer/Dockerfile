# 消费者容器镜像(docs/03 C1、docs/02 T1)。为什么必须容器而不是 zip:
# yt-dlp 是 Python 程序、ffmpeg 是 ~80MB 二进制,zip 部署的 250MB 解压上限
# 塞不下也不好升级;yt-dlp 是全系统更新最频繁的依赖(YouTube 军备竞赛),
# 升级路径必须是「改一行重新部署」。
#
# 架构注意:本镜像按 x86_64 构建(ffmpeg 静态包对应 amd64)——CDK 里的
# DockerImageFunction 必须配 Architecture.X86_64(占位 zip 是 ARM_64,换的
# 时候别忘了改)。
#
# 构建前先打包代码:npm run build:consumer(产物 consumer/dist/lambda.mjs)。

FROM public.ecr.aws/lambda/nodejs:22

# ffmpeg 解包要用的 tar/xz(Lambda 基础镜像是最小化 AL2023,没带)
RUN dnf install -y tar xz && dnf clean all

# yt-dlp 用官方单文件 Linux 二进制(自带 Python 运行时,x86_64)——
# 不走 dnf python3 + pip:基础镜像里那套 python 缺 SSL 模块,pip 连不上
# PyPI(构建实测)。版本钉死,YouTube 反爬升级时改这一行重新部署。
#
# >>> 这一行是本产品**最容易过期的一处**,过期的症状是任务在下载这一步猝死:
# >>>   字幕 429 Too Many Requests / 音频 403 Forbidden
# >>> 看着像被限流或被封 IP,其实是 YouTube 把旧版用的那个 player client 关了。
# >>> 2026-09-04 就栽在这里:钉着 2026.06.09,线上任务 30 秒失败;同一条视频
# >>> 换 2026.08.19 直接成功(它改用 visionos 客户端),本机直连、走代理都一样。
# >>> **别再往代理和限流上查**——先把这一行升到最新 release 重建镜像试一次:
# >>>   https://github.com/yt-dlp/yt-dlp/releases/latest
RUN curl -sL https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

# ffmpeg 静态编译版(johnvansickle amd64 build)
RUN cd /tmp && \
    curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o ffmpeg.tar.xz && \
    tar xf ffmpeg.tar.xz && \
    mv ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg && \
    rm -rf /tmp/ffmpeg*

# esbuild 单文件产物,无 node_modules
COPY dist/lambda.mjs ${LAMBDA_TASK_ROOT}/lambda.mjs

CMD ["lambda.handler"]
