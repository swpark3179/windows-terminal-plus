# rterm 셸 통합 — 프롬프트가 그려질 때마다 현재 폴더를 OSC 9;9 로 알린다.
#
# 앱은 이 값을 창별로 기억했다가, 다음에 켤 때 같은 폴더에서 셸을 띄운다.
# 윈도우에서는 남의 프로세스 작업 폴더를 밖에서 읽을 수 없어 이 길밖에 없다.
#
# 이 파일은 `-NoExit -Command ". <경로>"` 로 **프로필이 로드된 뒤에** 실행된다.
# 그래서 사용자가 프로필에서 정의한 prompt 를 그대로 감쌀 수 있다.

if (-not $global:__rtermWrapped) {
  $global:__rtermWrapped = $true

  # 프로필이 정의한 prompt. 아무것도 없으면 $null 이다.
  $global:__rtermInnerPrompt = $function:prompt

  function global:prompt {
    $text = if ($global:__rtermInnerPrompt) {
      & $global:__rtermInnerPrompt
    } else {
      "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }

    $loc = $executionContext.SessionState.Path.CurrentLocation
    # 레지스트리·인증서 드라이브에 들어가 있을 때는 알릴 폴더가 없다.
    if ($loc.Provider.Name -eq 'FileSystem') {
      $e = [char]27
      # Write-Host 가 아니라 [Console]::Write — PSReadLine 의 렌더링과 얽히지 않는다.
      [Console]::Write("$e]9;9;$($loc.ProviderPath)$e\")
    }

    $text
  }
}
