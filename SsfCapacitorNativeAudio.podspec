require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# CocoaPods doesn't like the "git+" prefix that npm allows.
repo_url = package.dig('repository', 'url').to_s.sub(/^git\+/, '')

Pod::Spec.new do |s|
  # Keep this aligned with Capacitor's derived SwiftPM product name:
  # "ssf-capacitor-native-audio" -> "SsfCapacitorNativeAudio"
  s.name = 'SsfCapacitorNativeAudio'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = repo_url
  s.author = package['author']
  s.source = { :git => repo_url, :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
