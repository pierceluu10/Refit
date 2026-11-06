resource "aws_lambda_function" "report" {
  function_name = "report"
  runtime       = "nodejs22.x"
  handler       = "index.handler"
}
